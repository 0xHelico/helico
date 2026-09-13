package prices

import (
	"context"
	"fmt"
	"math/big"
	"strings"
	"sync/atomic"
	"testing"
)

// fakeFeed answers like the aggregator proxy: rounds 1..n in phase 3, one an hour, the price
// rising a dollar a round from a base. Round ids below 1 revert, like the real thing.
type fakeFeed struct {
	n       uint64
	base    int64        // first round's updatedAt
	calls   atomic.Int64 // round trips: single calls plus one per batch
	batches atomic.Int64
}

func (f *fakeFeed) EthCall(_ context.Context, _ string, data string) (string, error) {
	f.calls.Add(1)
	word := func(v *big.Int) string { return fmt.Sprintf("%064x", v) }
	encode := func(phase, agg uint64, answer int64, updated int64) string {
		id := new(big.Int).Or(new(big.Int).Lsh(big.NewInt(int64(phase)), 64), new(big.Int).SetUint64(agg))
		return "0x" + word(id) + word(big.NewInt(answer)) + word(big.NewInt(updated)) + word(big.NewInt(updated)) + word(id)
	}
	switch {
	case strings.HasPrefix(data, selDecimals):
		return "0x" + fmt.Sprintf("%064x", 8), nil
	case strings.HasPrefix(data, selLatestRoundData):
		return encode(3, f.n, 2000_00000000+int64(f.n)*100000000, f.base+int64(f.n-1)*3600), nil
	case strings.HasPrefix(data, selGetRoundData):
		id, _ := new(big.Int).SetString(strings.TrimPrefix(data, selGetRoundData), 16)
		phase := new(big.Int).Rsh(id, 64).Uint64()
		agg := new(big.Int).And(id, new(big.Int).SetUint64(^uint64(0))).Uint64()
		if phase != 3 || agg == 0 || agg > f.n {
			return "", fmt.Errorf("execution reverted")
		}
		return encode(3, agg, 2000_00000000+int64(agg)*100000000, f.base+int64(agg-1)*3600), nil
	}
	return "", fmt.Errorf("unexpected call %s", data[:10])
}

func (f *fakeFeed) EthCalls(ctx context.Context, to string, data []string) ([]string, error) {
	f.batches.Add(1)
	if len(data) > batchSize {
		return nil, fmt.Errorf("Too Many Requests")
	}
	out := make([]string, len(data))
	for i, d := range data {
		raw, err := f.EthCall(ctx, to, d)
		if err != nil && !strings.Contains(err.Error(), "revert") {
			return nil, err
		}
		out[i] = raw
	}
	// Counted once per batch, so the tests measure round trips rather than rounds.
	f.calls.Add(int64(1 - len(data)))
	return out, nil
}

// expect is the round the fake would answer for t: the last one at or before it, and the
// first when t is older than the feed.
func (f *fakeFeed) expect(t int64) (agg uint64, price float64) {
	if t < f.base {
		return 1, 2001
	}
	agg = uint64((t-f.base)/3600) + 1
	if agg > f.n {
		agg = f.n
	}
	return agg, 2000 + float64(agg)
}

func TestTheSeriesIsTheLastRoundAtOrBeforeEachSample(t *testing.T) {
	// Rounds fall at 2800 past each hour, so a sample on the hour is never on a round: the
	// answer must be the round before it, never the one after.
	feed := &fakeFeed{n: 200, base: 1_000_000}
	svc := New(feed, "")
	from, to := feed.base+10*3600+1800, feed.base+30*3600+1800
	pts, err := svc.Series(context.Background(), from, to, 7200)
	if err != nil {
		t.Fatal(err)
	}
	// The first sample is moved down onto the two-hour grid: at or before `from`, never after.
	grid := from - from%7200
	if pts[0].T != grid || pts[0].T > from || from-pts[0].T >= 7200 {
		t.Fatalf("first sample at %d for from=%d (grid %d)", pts[0].T, from, grid)
	}
	// Samples every two hours to `to`, plus the feed's latest reading.
	var samples []Point
	for _, p := range pts {
		if p.T <= to {
			samples = append(samples, p)
		}
	}
	if len(samples) != 11 || len(pts) != 12 {
		t.Fatalf("samples = %d, points = %d: %+v", len(samples), len(pts), pts)
	}
	for i, p := range samples {
		if p.T != grid+int64(i)*7200 {
			t.Errorf("sample %d: t=%d, want %d", i, p.T, grid+int64(i)*7200)
		}
		if _, want := feed.expect(p.T); p.Price != want {
			t.Errorf("sample %d at %d: price %.2f, want %.2f", i, p.T, p.Price, want)
		}
	}
	last := pts[11]
	if last.Price != 2200 || last.T != feed.base+199*3600 {
		t.Errorf("the latest reading is not the feed's: %+v", last)
	}
}

func TestPastSamplesAreReadOnce(t *testing.T) {
	feed := &fakeFeed{n: 5000, base: 1_000_000}
	svc := New(feed, "")
	from, to := feed.base+100*3600, feed.base+124*3600
	if _, err := svc.Series(context.Background(), from, to, 3600); err != nil {
		t.Fatal(err)
	}
	first := feed.calls.Load()
	if _, err := svc.Series(context.Background(), from, to, 3600); err != nil {
		t.Fatal(err)
	}
	// The second read costs the latest round and nothing else: every sample and every round on
	// its search path is remembered.
	if again := feed.calls.Load() - first; again > 2 {
		t.Fatalf("a repeated window cost %d calls; the answers are immutable", again)
	}
	// And the first read was a handful of round trips, not a bisection per sample: every level
	// of the search is one batch for all 25 samples, and the interpolation step lands close on
	// evenly spaced rounds. Latest, decimals, first round, then the levels.
	if first > 3+8 {
		t.Fatalf("first read cost %d round trips", first)
	}
}

func TestBeforeThePhaseBeganIsTheFirstRound(t *testing.T) {
	feed := &fakeFeed{n: 50, base: 1_000_000}
	svc := New(feed, "")
	pts, err := svc.Series(context.Background(), feed.base-7200, feed.base-3600, 3600)
	if err != nil {
		t.Fatal(err)
	}
	if len(pts) < 2 || pts[0].Price != 2001 || pts[1].Price != 2001 {
		t.Fatalf("before the first round should answer the first round's price: %+v", pts)
	}
}

func TestTheWindowNeverExceedsMaxPoints(t *testing.T) {
	for _, span := range []int64{3600, 86400, 30 * 86400, 365 * 86400, 5 * 365 * 86400} {
		step := Window(0, span)
		if span/step+1 > MaxPoints {
			t.Errorf("span %d: step %d gives %d points", span, step, span/step+1)
		}
		if span <= 29*86400 && step != 3600 {
			t.Errorf("span %d: under a month is hourly, got %d", span, step)
		}
	}
	svc := New(&fakeFeed{n: 10, base: 0}, "")
	if _, err := svc.Series(context.Background(), 0, 10_000*3600, 3600); err == nil {
		t.Fatal("more than MaxPoints was not refused")
	}
}
