// Package prices answers "what was ether worth at that moment" from the Chainlink feed's own
// round history, so a portfolio line can carry an ether position at the price of each point
// rather than at today's.
//
// **The feed is the source, the same one the dapp sizes dollars with.** Chainlink's ETH/USD
// aggregator on Arbitrum One keeps every round it ever published — `getRoundData(id)` answers
// `(answer, updatedAt)` for any past id — so a price at a timestamp is a search over round ids
// for the last round at or before it. Round ids are sequential within a phase and the proxy
// encodes the phase in the top bits, so the search runs over the current phase's ids and stops
// at its first round for anything older.
//
// **Searched in batches, because the endpoint is far away.** One `eth_call` to the public
// endpoint is ~0.4 s from either the dapp's server or a laptop, and a bisection is seventeen of
// them in a row. So every sample in a window searches at once: each level of the search is one
// JSON-RPC batch carrying every sample's next probe, the interval halves for all of them
// together, and the interpolation step — rounds land about every three minutes, so a timestamp
// says roughly which round — cuts the levels to a handful. Measured on the live feed: a day by
// the hour is under three seconds cold and nothing warm.
//
// **Cached because it is immutable.** A past round never changes, and a past hour's price never
// changes, so both are kept for the life of the process: the second reader of a window costs the
// latest round and nothing else.
package prices

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"sort"
	"strings"
	"sync"
	"time"
)

// Caller is `eth_call` against the latest block, one at a time or as one JSON-RPC batch.
// `*activity.RPC` satisfies it. In a batch, an entry the contract reverted comes back as "".
type Caller interface {
	EthCall(ctx context.Context, to, data string) (string, error)
	EthCalls(ctx context.Context, to string, data []string) ([]string, error)
}

// Feed is a Chainlink aggregator proxy: ETH/USD on Arbitrum One, the one `apps/app/lib/usd.ts`
// reads, unless another is configured.
const Feed = "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612"

// Selectors, from the AggregatorV3Interface.
const (
	selLatestRoundData = "0xfeaf968c" // latestRoundData()
	selGetRoundData    = "0x9a6fc8f5" // getRoundData(uint80)
	selDecimals        = "0x313ce567" // decimals()
)

// batchSize is what the public Arbitrum endpoint accepts in one JSON-RPC batch: fifty answered,
// sixty was refused with 429 (measured 13 Sep 2026).
const batchSize = 40

// Point is the feed's answer at one moment: the price in dollars, and the round it came from.
type Point struct {
	T     int64   `json:"t"`
	Price float64 `json:"price"`
	Round string  `json:"round,omitempty"`
}

// A round id on the proxy is `phaseId << 64 | aggregatorRound`, a uint80; it is kept as its two
// halves, since the search runs over the aggregator half within one phase.
type round struct {
	phase     uint64
	agg       uint64
	answer    *big.Int
	updatedAt int64 // zero for a round the phase never wrote
}

func (r round) id() *big.Int {
	return new(big.Int).Or(new(big.Int).Lsh(big.NewInt(int64(r.phase)), 64), new(big.Int).SetUint64(r.agg))
}

type roundKey struct{ phase, agg uint64 }

// Service reads one feed and remembers what it read.
type Service struct {
	rpc      Caller
	feed     string
	mu       sync.Mutex
	decimals int
	rounds   map[roundKey]round // by phase and aggregator round
	hours    map[int64]Point    // by sample timestamp
}

func New(rpc Caller, feed string) *Service {
	if feed == "" {
		feed = Feed
	}
	return &Service{rpc: rpc, feed: strings.ToLower(feed), decimals: -1, rounds: map[roundKey]round{}, hours: map[int64]Point{}}
}

var ErrNoRounds = errors.New("the feed answered no rounds")

// MaxPoints bounds one request: 720 is a month by the hour, which is the widest window the dapp
// draws by the hour; anything wider asks with a coarser step.
const MaxPoints = 720

// Series answers the price at each `step`-second sample from `from` to `to` inclusive, plus the
// feed's latest reading when `to` is later than it. Past samples are read once and kept.
//
// **The samples sit on the step's own grid.** `from` is moved down to a multiple of `step`, so
// an hourly window starts on the hour whichever second it was asked at. Two readers a minute
// apart then ask for the same timestamps and the second costs nothing, and a two-hourly window
// shares every point with the hourly one. The first point is at or before `from`, which is what
// a line that steps between readings wants anyway.
func (s *Service) Series(ctx context.Context, from, to, step int64) ([]Point, error) {
	if step <= 0 || to < from {
		return nil, fmt.Errorf("a window runs forwards with a positive step")
	}
	if from > 0 {
		from -= from % step
	}
	if (to-from)/step+1 > MaxPoints+1 {
		return nil, fmt.Errorf("that is more than %d points; widen the step", MaxPoints)
	}
	latest, err := s.latest(ctx)
	if err != nil {
		return nil, err
	}
	dec, err := s.decimalsOf(ctx)
	if err != nil {
		return nil, err
	}
	var ts []int64
	for t := from; t <= to && t <= latest.updatedAt; t += step {
		ts = append(ts, t)
	}
	if err := s.resolve(ctx, ts, latest, dec); err != nil {
		return nil, err
	}
	out := make([]Point, 0, len(ts)+1)
	s.mu.Lock()
	for _, t := range ts {
		out = append(out, s.hours[t])
	}
	s.mu.Unlock()
	// The feed's own latest reading, dated as the feed dates it, so the line's right end is the
	// number the headline prices with rather than an hour-old sample.
	if last := s.point(latest, latest.updatedAt, dec); len(out) == 0 || out[len(out)-1].Round != last.Round {
		out = append(out, last)
	}
	return out, nil
}

// pending is one sample still being searched: the answer is the greatest round whose updatedAt
// is at or before t, and it lies in [lo, hi) — lo is at or before t, hi is after it.
type pending struct {
	t      int64
	lo, hi round
}

// resolve fills `hours` for every t in ts, all searched together, one batch per level.
//
// The probe alternates between an interpolation — where t falls between lo and hi by time,
// mapped onto the rounds between them — and a plain midpoint. Interpolation alone converges in
// a few steps on the feed's fairly even spacing and can crawl where a quiet night meets a busy
// morning; the midpoint every other level bounds the worst case at the bisection's own.
func (s *Service) resolve(ctx context.Context, ts []int64, latest round, dec int) error {
	first, err := s.round(ctx, latest.phase, 1)
	if err != nil {
		return err
	}
	if first.updatedAt == 0 {
		return ErrNoRounds
	}
	var open []pending
	s.mu.Lock()
	for _, t := range ts {
		if _, ok := s.hours[t]; ok {
			continue
		}
		switch {
		case t >= latest.updatedAt:
			s.hours[t] = s.point(latest, t, dec)
		case t < first.updatedAt:
			// Older than this phase's first round: the earliest price this phase knows is the
			// honest floor, reported with that round's own id so a reader can see it is one.
			s.hours[t] = s.point(first, t, dec)
		default:
			lo, hi := s.boundsLocked(t, first, latest)
			open = append(open, pending{t: t, lo: lo, hi: hi})
		}
	}
	s.mu.Unlock()

	for level := 0; len(open) > 0; level++ {
		if level > 64 {
			return fmt.Errorf("the search did not converge")
		}
		probes := make(map[uint64]struct{}, len(open))
		want := make([]uint64, 0, len(open))
		for i := range open {
			p := &open[i]
			if p.hi.agg-p.lo.agg <= 1 {
				continue
			}
			var agg uint64
			if level%2 == 0 {
				span := float64(p.hi.updatedAt - p.lo.updatedAt)
				frac := float64(p.t-p.lo.updatedAt) / span
				agg = p.lo.agg + uint64(frac*float64(p.hi.agg-p.lo.agg))
			} else {
				agg = p.lo.agg + (p.hi.agg-p.lo.agg)/2
			}
			if agg <= p.lo.agg {
				agg = p.lo.agg + 1
			}
			if agg >= p.hi.agg {
				agg = p.hi.agg - 1
			}
			if _, seen := probes[agg]; !seen {
				probes[agg] = struct{}{}
				want = append(want, agg)
			}
		}
		if len(want) > 0 {
			if err := s.fetch(ctx, latest.phase, want); err != nil {
				return err
			}
		}
		// Narrow every open sample by every round now known, not only its own probe: a
		// neighbour's probe an hour away is often the tighter bound.
		s.mu.Lock()
		still := open[:0]
		for _, p := range open {
			p.lo, p.hi = s.boundsLocked(p.t, p.lo, p.hi)
			if p.hi.agg-p.lo.agg <= 1 {
				s.hours[p.t] = s.point(p.lo, p.t, dec)
				continue
			}
			still = append(still, p)
		}
		open = still
		s.mu.Unlock()
	}
	return nil
}

// boundsLocked tightens [lo, hi) for t from every round the cache holds in lo's phase. Called
// with the lock held. A round the phase never wrote has no time and is skipped.
func (s *Service) boundsLocked(t int64, lo, hi round) (round, round) {
	for k, r := range s.rounds {
		if k.phase != lo.phase || r.updatedAt == 0 {
			continue
		}
		if r.updatedAt <= t && r.agg > lo.agg {
			lo = r
		} else if r.updatedAt > t && r.agg < hi.agg {
			hi = r
		}
	}
	return lo, hi
}

// fetch reads the named aggregator rounds of one phase, in batches, and caches each. A round
// the contract reverted on is cached empty so it is asked once.
func (s *Service) fetch(ctx context.Context, phase uint64, aggs []uint64) error {
	sort.Slice(aggs, func(i, j int) bool { return aggs[i] < aggs[j] })
	for start := 0; start < len(aggs); start += batchSize {
		end := start + batchSize
		if end > len(aggs) {
			end = len(aggs)
		}
		chunk := aggs[start:end]
		data := make([]string, len(chunk))
		for i, agg := range chunk {
			data[i] = selGetRoundData + fmt.Sprintf("%064x", round{phase: phase, agg: agg}.id())
		}
		raws, err := s.calls(ctx, data)
		if err != nil {
			return fmt.Errorf("getRoundData ×%d: %w", len(chunk), err)
		}
		if len(raws) != len(chunk) {
			return fmt.Errorf("getRoundData ×%d: %d answers", len(chunk), len(raws))
		}
		s.mu.Lock()
		for i, raw := range raws {
			r := round{phase: phase, agg: chunk[i]}
			if raw != "" {
				decoded, err := decodeRound(raw)
				if err != nil {
					s.mu.Unlock()
					return err
				}
				r.answer, r.updatedAt = decoded.answer, decoded.updatedAt
			}
			s.rounds[roundKey{phase, chunk[i]}] = r
		}
		s.mu.Unlock()
	}
	return nil
}

// calls is one batch, retried with a pause when the endpoint says it is being asked too fast.
// The public endpoint answers 429 in bursts rather than by a rule anyone published — six
// batches of forty back to back went through one minute and the fourth was refused the next —
// so a refusal is waited out rather than reported, three times, before it is a failure.
func (s *Service) calls(ctx context.Context, data []string) ([]string, error) {
	var last error
	for attempt, wait := 0, 400*time.Millisecond; attempt < 4; attempt, wait = attempt+1, wait*2 {
		raws, err := s.rpc.EthCalls(ctx, s.feed, data)
		if err == nil {
			return raws, nil
		}
		last = err
		if !strings.Contains(err.Error(), "Too Many Requests") && !strings.Contains(err.Error(), "429") {
			return nil, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(wait):
		}
	}
	return nil, last
}

func (s *Service) point(r round, t int64, dec int) Point {
	f := new(big.Float).SetInt(r.answer)
	f.Quo(f, new(big.Float).SetInt(new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(dec)), nil)))
	price, _ := f.Float64()
	return Point{T: t, Price: price, Round: r.id().String()}
}

func (s *Service) latest(ctx context.Context) (round, error) {
	raw, err := s.rpc.EthCall(ctx, s.feed, selLatestRoundData)
	if err != nil {
		return round{}, fmt.Errorf("latestRoundData: %w", err)
	}
	r, err := decodeRound(raw)
	if err != nil {
		return round{}, err
	}
	s.mu.Lock()
	s.rounds[roundKey{r.phase, r.agg}] = r
	s.mu.Unlock()
	return r, nil
}

// round is one aggregator round of one phase, from the cache or the chain.
func (s *Service) round(ctx context.Context, phase, agg uint64) (round, error) {
	key := roundKey{phase, agg}
	s.mu.Lock()
	r, ok := s.rounds[key]
	s.mu.Unlock()
	if ok {
		return r, nil
	}
	if err := s.fetch(ctx, phase, []uint64{agg}); err != nil {
		return round{}, err
	}
	s.mu.Lock()
	r = s.rounds[key]
	s.mu.Unlock()
	return r, nil
}

func (s *Service) decimalsOf(ctx context.Context) (int, error) {
	s.mu.Lock()
	d := s.decimals
	s.mu.Unlock()
	if d >= 0 {
		return d, nil
	}
	raw, err := s.rpc.EthCall(ctx, s.feed, selDecimals)
	if err != nil {
		return 0, fmt.Errorf("decimals: %w", err)
	}
	n, ok := new(big.Int).SetString(strings.TrimPrefix(raw, "0x"), 16)
	if !ok || !n.IsInt64() || n.Int64() > 36 {
		return 0, fmt.Errorf("decimals: %q is not a small number", raw)
	}
	s.mu.Lock()
	s.decimals = int(n.Int64())
	s.mu.Unlock()
	return int(n.Int64()), nil
}

// decodeRound reads `(uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt,
// uint80 answeredInRound)`. A round with no data comes back all zero.
func decodeRound(raw string) (round, error) {
	b, err := hex.DecodeString(strings.TrimPrefix(raw, "0x"))
	if err != nil || len(b) < 160 {
		return round{}, fmt.Errorf("round: %d bytes is not five words", len(b))
	}
	id := new(big.Int).SetBytes(b[0:32])
	answer := new(big.Int).SetBytes(b[32:64])
	if b[32]&0x80 != 0 { // negative, which a price feed never is; refuse rather than wrap
		return round{}, fmt.Errorf("round: negative answer")
	}
	updated := new(big.Int).SetBytes(b[96:128])
	if id.BitLen() > 80 || !updated.IsInt64() {
		return round{}, fmt.Errorf("round: id or time out of range")
	}
	phase := new(big.Int).Rsh(id, 64)
	agg := new(big.Int).And(id, new(big.Int).SetUint64(^uint64(0)))
	return round{phase: phase.Uint64(), agg: agg.Uint64(), answer: answer, updatedAt: updated.Int64()}, nil
}

// Warm reads each of the given windows — `days` back from now — once now and again every
// `every`, in the background, until ctx ends. The dapp draws a day, a week, a month, a quarter
// and a year; cold, a month is fifteen seconds of batches against the public endpoint, which
// is longer than a request may take. Warm, it is the latest round and a lookup. Because past
// samples are kept and a window's grid is fixed, each pass after the first costs only the
// samples that have appeared since.
func (s *Service) Warm(ctx context.Context, days []int, every time.Duration, log func(msg string, args ...any)) {
	pass := func() {
		for _, d := range days {
			now := time.Now().Unix()
			from := now - int64(d)*86400
			step := Window(from, now)
			started := time.Now()
			if _, err := s.Series(ctx, from, now, step); err != nil {
				log("prices warm", "days", d, "err", err)
				continue
			}
			log("prices warm", "days", d, "step", step, "took", time.Since(started).Round(time.Millisecond).String())
		}
	}
	pass()
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			pass()
		}
	}
}

// Window is the sampling the dapp asks for: hourly for a month, coarser beyond, never more than
// MaxPoints. Exposed so the handler and the tests agree on it.
func Window(from, to int64) (step int64) {
	span := to - from
	step = 3600
	for span/step+1 > MaxPoints {
		step *= 2
	}
	return step
}
