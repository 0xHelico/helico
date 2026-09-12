package activity

import (
	"context"
	"errors"
	"testing"
	"time"
)

// The three topics, asserted against the values the chain actually carries. A topic typed from
// memory is a filter that silently matches nothing, and the failure looks like an empty account.
func TestTheTopicsAreTheOnesTheChainCarries(t *testing.T) {
	// Read from the live account 0x0acdfa21… on 11 September 2026: eight logs, these three topic0s.
	for _, c := range []struct{ name, want string }{
		{"IdleCapitalMoved", "0x31b0a7503f02d1d00b2290939640f339abd3c47aa9e41dd6fcc7fa17f2d3cad3"},
		{"AgentChanged", "0x4a2e63eb36ad3c667a1d8d1b18dfbf37d06f96b46b82b526a855175916515add"},
		{"VenuePermitted", "0xdae93fbd597062922eea00db27bacf375a602e285a1a9eb57639838a5ac75182"},
	} {
		got := map[string]string{
			"IdleCapitalMoved": TopicIdleCapitalMoved,
			"AgentChanged":     TopicAgentChanged,
			"VenuePermitted":   TopicVenuePermitted,
		}[c.name]
		if got != c.want {
			t.Errorf("%s topic is %s, want %s", c.name, got, c.want)
		}
	}
}

func TestNormaliseRefusesWhatIsNotAnAddress(t *testing.T) {
	if _, err := Normalise("0x0ACDFA21A3CD075AEE6583C8A8069F86AD3E4A39"); err != nil {
		t.Fatalf("an upper-case address is an address: %v", err)
	}
	// Lower-cased, because `0xAbC…` and `0xabc…` as two rows is duplicate history that looks real.
	got, _ := Normalise("  0x0ACDFA21A3CD075AEE6583C8A8069F86AD3E4A39 ")
	if got != "0x0acdfa21a3cd075aee6583c8a8069f86ad3e4a39" {
		t.Errorf("not normalised: %s", got)
	}
	for _, bad := range []string{"", "0x", "acd075aee6583c8a8069f86ad3e4a390acdfa21", "0xzz"} {
		if _, err := Normalise(bad); !errors.Is(err, ErrBadAddress) {
			t.Errorf("%q was accepted", bad)
		}
	}
}

// The real supply, decoded from the log the chain emitted at block 504035561.
func TestDecodesTheMoveTheEnclaveMade(t *testing.T) {
	e, ok := decode(rawLog{
		Topics: []string{
			TopicIdleCapitalMoved,
			"0x000000000000000000000000bba798a61f0d7d1ae51466fd4045cd2ea25c9a29",
			"0x000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e5831",
		},
		// 490081, then true.
		Data: "0x" +
			"0000000000000000000000000000000000000000000000000000000000077a61" +
			"0000000000000000000000000000000000000000000000000000000000000001",
		BlockNumber: "0x1e0b4fa9",
		LogIndex:    "0x7",
		TxHash:      "0x0668c698cf3d396e622a97bfa3e21016de44fb41863fa7cb69b47bd126f9ed27",
	})
	if !ok {
		t.Fatal("the move did not decode")
	}
	if e.Kind != KindMoved {
		t.Errorf("kind %s", e.Kind)
	}
	if e.Amount != "490081" {
		t.Errorf("amount %s, want 490081", e.Amount)
	}
	if !e.Supplied {
		t.Error("supplied should be true: this was money going in")
	}
	if e.Pool != "0xbba798a61f0d7d1ae51466fd4045cd2ea25c9a29" {
		t.Errorf("pool %s", e.Pool)
	}
	if e.Asset != "0xaf88d065e77c8cc2239327c5edb3a432268e5831" {
		t.Errorf("asset %s", e.Asset)
	}
	if e.LogIndex != 7 {
		t.Errorf("log index %d", e.LogIndex)
	}
}

func TestAWithdrawalIsNotASupply(t *testing.T) {
	e, _ := decode(rawLog{
		Topics: []string{TopicIdleCapitalMoved,
			"0x000000000000000000000000bba798a61f0d7d1ae51466fd4045cd2ea25c9a29",
			"0x000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e5831"},
		Data: "0x" +
			"0000000000000000000000000000000000000000000000000000000000077a61" +
			"0000000000000000000000000000000000000000000000000000000000000000",
		BlockNumber: "0x1", LogIndex: "0x0", TxHash: "0xab",
	})
	if e.Supplied {
		t.Error("a false last word is money coming out")
	}
}

func TestRevokingTheAgentReadsAsTheZeroAddress(t *testing.T) {
	e, ok := decode(rawLog{
		Topics:      []string{TopicAgentChanged, "0x" + "0000000000000000000000000000000000000000000000000000000000000000"},
		Data:        "0x",
		BlockNumber: "0x1", LogIndex: "0x0", TxHash: "0xab",
	})
	if !ok || e.Kind != KindAgent {
		t.Fatalf("did not decode: %v %s", ok, e.Kind)
	}
	if e.Agent != "0x0000000000000000000000000000000000000000" {
		t.Errorf("agent %s", e.Agent)
	}
}

// A log that filters in on topic0 but has the wrong number of topics is not ours. Another contract
// reusing one of these signatures with different parameters would otherwise be read as an account.
func TestALogOfTheWrongShapeIsDropped(t *testing.T) {
	for _, l := range []rawLog{
		{Topics: []string{TopicIdleCapitalMoved, "0x00"}, Data: "0x", BlockNumber: "0x1", LogIndex: "0x0"},
		{Topics: []string{TopicAgentChanged}, Data: "0x", BlockNumber: "0x1", LogIndex: "0x0"},
		{Topics: []string{"0xdeadbeef"}, Data: "0x", BlockNumber: "0x1", LogIndex: "0x0"},
		{Topics: nil},
	} {
		if _, ok := decode(l); ok {
			t.Errorf("accepted a log of the wrong shape: %v", l.Topics)
		}
	}
}

// ── the service ─────────────────────────────────────────────────────────────

type fakeStore struct {
	readTo, checkedAt int64
	rows              []Event
	saves             int
}

func (f *fakeStore) ActivityCursor(context.Context, string) (int64, int64, error) {
	return f.readTo, f.checkedAt, nil
}
func (f *fakeStore) Activity(_ context.Context, _ string, limit int) ([]Event, error) {
	if len(f.rows) > limit {
		return f.rows[:limit], nil
	}
	return f.rows, nil
}
func (f *fakeStore) SaveActivity(_ context.Context, _ string, events []Event, readTo, checkedAt int64) error {
	f.saves++
	f.rows = append(events, f.rows...)
	f.readTo, f.checkedAt = readTo, checkedAt
	return nil
}

type fakeRPC struct {
	head      uint64
	asked     [][2]uint64
	logs      []Event
	headErr   error
	logsErr   error
	headCalls int
	timed     []uint64
	timesErr  error
	transfers []Event
	xferErr   error
	xferAsked [][2]uint64
	xferToken string
}

func (f *fakeRPC) Head(context.Context) (uint64, error) {
	f.headCalls++
	return f.head, f.headErr
}
func (f *fakeRPC) Logs(_ context.Context, _ string, from, to uint64) ([]Event, error) {
	f.asked = append(f.asked, [2]uint64{from, to})
	return f.logs, f.logsErr
}

func (f *fakeRPC) Transfers(_ context.Context, token, _ string, from, to uint64) ([]Event, error) {
	f.xferToken = token
	f.xferAsked = append(f.xferAsked, [2]uint64{from, to})
	return f.transfers, f.xferErr
}

func (f *fakeRPC) Times(_ context.Context, blocks []uint64) (map[uint64]uint64, error) {
	f.timed = append(f.timed, blocks...)
	out := make(map[uint64]uint64, len(blocks))
	for _, b := range blocks {
		out[b] = 1_700_000_000 + b
	}
	return out, f.timesErr
}

const account = "0x0acdfa21a3cd075aee6583c8a8069f86ad3e4a39"

func TestTheFirstReadScansFromTheFactoryAndTheSecondOnlyForward(t *testing.T) {
	store := &fakeStore{}
	rpc := &fakeRPC{head: 600, logs: []Event{{Block: 500, Kind: KindMoved}}}
	s := NewService(store, rpc, 100, time.Minute, 50)
	s.now = func() time.Time { return time.Unix(10_000, 0) }

	if _, err := s.For(context.Background(), account); err != nil {
		t.Fatal(err)
	}
	if rpc.asked[0] != [2]uint64{100, 600} {
		t.Errorf("first scan was %v, want the factory block to the head", rpc.asked[0])
	}

	// Past the freshness window, so it asks again — and from 601, never from 100.
	rpc.head = 900
	s.now = func() time.Time { return time.Unix(10_000+3600, 0) }
	if _, err := s.For(context.Background(), account); err != nil {
		t.Fatal(err)
	}
	if rpc.asked[1] != [2]uint64{601, 900} {
		t.Errorf("second scan was %v, want forward only", rpc.asked[1])
	}
}

func TestAFreshCursorAsksTheChainNothing(t *testing.T) {
	store := &fakeStore{readTo: 600, checkedAt: 10_000, rows: []Event{{Block: 500}}}
	rpc := &fakeRPC{head: 900}
	s := NewService(store, rpc, 100, time.Minute, 50)
	s.now = func() time.Time { return time.Unix(10_010, 0) }

	got, err := s.For(context.Background(), account)
	if err != nil {
		t.Fatal(err)
	}
	if rpc.headCalls != 0 {
		t.Error("a fresh cursor should cost nothing upstream")
	}
	if got.Fetched {
		t.Error("nothing was fetched")
	}
	if len(got.Events) != 1 {
		t.Errorf("served %d rows", len(got.Events))
	}
}

// An endpoint that will not answer is a reason to show what is known, not to show nothing. The
// rows below the cursor are final, so there is nothing stale about them.
func TestAnEndpointThatWillNotAnswerStillServesWhatIsKnown(t *testing.T) {
	store := &fakeStore{readTo: 600, checkedAt: 1, rows: []Event{{Block: 500, Kind: KindAgent}}}
	s := NewService(store, &fakeRPC{headErr: errors.New("missing trie node")}, 100, time.Minute, 50)
	s.now = func() time.Time { return time.Unix(10_000, 0) }

	got, err := s.For(context.Background(), account)
	if err != nil {
		t.Fatalf("a dead endpoint is not an error for the reader: %v", err)
	}
	if len(got.Events) != 1 || got.Fetched {
		t.Errorf("served %d rows, fetched %v", len(got.Events), got.Fetched)
	}
}

func TestALogScanThatFailsDoesNotMoveTheCursor(t *testing.T) {
	store := &fakeStore{readTo: 600, checkedAt: 1}
	rpc := &fakeRPC{head: 900, logsErr: errors.New("range too wide")}
	s := NewService(store, rpc, 100, time.Minute, 50)
	s.now = func() time.Time { return time.Unix(10_000, 0) }

	if _, err := s.For(context.Background(), account); err != nil {
		t.Fatal(err)
	}
	// A cursor moved past logs that were never read would skip them for ever.
	if store.readTo != 600 {
		t.Errorf("cursor moved to %d on a failed scan", store.readTo)
	}
}

func TestAHeadThatHasNotMovedStillRefreshesTheCursor(t *testing.T) {
	store := &fakeStore{readTo: 900, checkedAt: 1}
	rpc := &fakeRPC{head: 900}
	s := NewService(store, rpc, 100, time.Minute, 50)
	s.now = func() time.Time { return time.Unix(10_000, 0) }

	if _, err := s.For(context.Background(), account); err != nil {
		t.Fatal(err)
	}
	if len(rpc.asked) != 0 {
		t.Error("there was nothing to scan")
	}
	// Otherwise every visitor in a quiet hour pays for the head call again.
	if store.checkedAt != 10_000 {
		t.Errorf("checked_at is %d, so the next visitor pays too", store.checkedAt)
	}
}

func TestABadAddressIsRefusedBeforeAnythingIsAsked(t *testing.T) {
	rpc := &fakeRPC{head: 900}
	s := NewService(&fakeStore{}, rpc, 100, time.Minute, 50)
	if _, err := s.For(context.Background(), "not-an-address"); !errors.Is(err, ErrBadAddress) {
		t.Errorf("err is %v", err)
	}
	if rpc.headCalls != 0 {
		t.Error("it asked the chain about a string that is not an address")
	}
}

// One header per block that carries an event, not one per event and not one per block scanned.
// The onboarding batch is five events in a single block; asking five times for the same header is
// four calls nobody needs.
func TestTheTimestampIsAskedForOncePerBlock(t *testing.T) {
	store := &fakeStore{}
	rpc := &fakeRPC{head: 600, logs: []Event{
		{Block: 500, LogIndex: 0}, {Block: 500, LogIndex: 1}, {Block: 500, LogIndex: 2},
		{Block: 540, LogIndex: 0},
	}}
	s := NewService(store, rpc, 100, time.Minute, 50)
	s.now = func() time.Time { return time.Unix(10_000, 0) }

	if _, err := s.For(context.Background(), account); err != nil {
		t.Fatal(err)
	}
	if len(rpc.timed) != 2 {
		t.Errorf("asked for %d headers, want 2 (blocks 500 and 540)", len(rpc.timed))
	}
	for _, e := range store.rows {
		if e.BlockTime == 0 {
			t.Errorf("block %d has no time", e.Block)
		}
	}
}

// A header that will not come back is a missing date, not a failed read. The event still lands.
func TestAMissingHeaderStillWritesTheEvent(t *testing.T) {
	store := &fakeStore{}
	rpc := &fakeRPC{head: 600, logs: []Event{{Block: 500}}, timesErr: errors.New("no")}
	s := NewService(store, rpc, 100, time.Minute, 50)
	s.now = func() time.Time { return time.Unix(10_000, 0) }

	got, err := s.For(context.Background(), account)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Events) != 1 {
		t.Fatalf("%d rows", len(got.Events))
	}
	if got.Events[0].BlockTime != 0 {
		t.Error("a date that could not be read should be zero, not invented")
	}
}

// The real deposit, decoded from the USDC log at block 504019200: 0.500081 USDC arriving at the
// account. Nothing a Helico contract emitted says this happened, which is the whole reason the
// package reads transfers at all.
func TestDecodesTheDepositThatFundedTheAccount(t *testing.T) {
	e, ok := decodeTransfer(rawLog{
		Address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
		Topics: []string{
			TopicTransfer,
			"0x0000000000000000000000003b4f0135465d444a5bd06ab90fc59b73916c85f5",
			"0x0000000000000000000000000acdfa21a3cd075aee6583c8a8069f86ad3e4a39",
		},
		Data:        "0x000000000000000000000000000000000000000000000000000000000007a171",
		BlockNumber: "0x1e0b0f40",
		LogIndex:    "0x3",
		TxHash:      "0x870fbb53190000000000000000000000000000000000000000000000000000000",
	}, account)
	if !ok {
		t.Fatal("the deposit did not decode")
	}
	if e.Kind != KindIn {
		t.Errorf("kind %s, want in", e.Kind)
	}
	if e.Amount != "500081" {
		t.Errorf("amount %s, want 500081", e.Amount)
	}
	if e.Pool != "0x3b4f0135465d444a5bd06ab90fc59b73916c85f5" {
		t.Errorf("counterparty %s, want the owner who funded it", e.Pool)
	}
	// Lower-cased like every other address here, or the token is two rows in one table.
	if e.Asset != "0xaf88d065e77c8cc2239327c5edb3a432268e5831" {
		t.Errorf("asset %s", e.Asset)
	}
}

// The direction comes from the topics, not from which of the two queries returned the log. A
// decoder that trusted the query would read every row as a deposit the moment the two were merged.
func TestTheDirectionIsReadFromTheLogItself(t *testing.T) {
	out, ok := decodeTransfer(rawLog{
		Address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
		Topics: []string{
			TopicTransfer,
			"0x0000000000000000000000000acdfa21a3cd075aee6583c8a8069f86ad3e4a39",
			"0x000000000000000000000000bba798a61f0d7d1ae51466fd4045cd2ea25c9a29",
		},
		Data:        "0x0000000000000000000000000000000000000000000000000000000000077a61",
		BlockNumber: "0x1e0b4fa9",
		LogIndex:    "0x5",
		TxHash:      "0x0668c698cf3d396e622a97bfa3e21016de44fb41863fa7cb69b47bd126f9ed27",
	}, account)
	if !ok {
		t.Fatal("the outgoing transfer did not decode")
	}
	if out.Kind != KindOut {
		t.Errorf("kind %s, want out", out.Kind)
	}
	if out.Supplied {
		t.Error("supplied is the incoming flag and this went the other way")
	}

	// An account paying itself moves nothing, and counted on both sides it is two rows for an
	// event that did not happen to anyone's money.
	me := "0x000000000000000000000000" + account[2:]
	if _, ok := decodeTransfer(rawLog{
		Address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
		Topics:  []string{TopicTransfer, me, me},
		Data:    "0x0000000000000000000000000000000000000000000000000000000000000001",
	}, account); ok {
		t.Error("a self-transfer was counted")
	}

	// A log that is not a Transfer must not be read as one: the topic is shared by every ERC-20
	// on the chain and the filter is the only thing keeping other contracts out.
	if _, ok := decodeTransfer(rawLog{
		Topics: []string{TopicIdleCapitalMoved, me, me},
	}, account); ok {
		t.Error("a non-transfer decoded as a transfer")
	}
}

// The transfers are scanned over the same range as the account's own events, and stored under the
// same cursor. A second range would be a second watermark to keep in step, and the one that fell
// behind would drop rows for ever.
func TestTransfersShareTheScanAndTheCursor(t *testing.T) {
	store := &fakeStore{}
	rpc := &fakeRPC{
		head:      600,
		logs:      []Event{{Block: 500, Kind: KindMoved}},
		transfers: []Event{{Block: 400, Kind: KindIn, Amount: "500081"}},
	}
	s := NewService(store, rpc, 100, time.Minute, 50)
	s.now = func() time.Time { return time.Unix(10_000, 0) }

	if _, err := s.For(context.Background(), account); err != nil {
		t.Fatal(err)
	}
	if len(rpc.xferAsked) != 1 || rpc.xferAsked[0] != [2]uint64{100, 600} {
		t.Errorf("transfers were scanned over %v, want the same range as the events", rpc.xferAsked)
	}
	if rpc.xferToken != USDC {
		t.Errorf("scanned %s, want USDC", rpc.xferToken)
	}
	if len(store.rows) != 2 {
		t.Fatalf("stored %d rows, want the move and the deposit", len(store.rows))
	}
	// Both blocks get a header, or half the series has no date to be plotted at.
	if len(rpc.timed) != 2 {
		t.Errorf("timed %v, want a header for each block that carries an event", rpc.timed)
	}
}

// **Neither half is saved without the other.** The cursor moves past everything the scan covered,
// so writing the account's events while the transfers failed would put that range out of reach and
// leave the deposit missing for ever, with nothing to say it had gone.
func TestAFailedTransferScanSavesNothing(t *testing.T) {
	store := &fakeStore{}
	rpc := &fakeRPC{
		head:    600,
		logs:    []Event{{Block: 500, Kind: KindMoved}},
		xferErr: errors.New("the endpoint would not say"),
	}
	s := NewService(store, rpc, 100, time.Minute, 50)
	s.now = func() time.Time { return time.Unix(10_000, 0) }

	got, err := s.For(context.Background(), account)
	if err != nil {
		t.Fatal(err)
	}
	if got.Fetched {
		t.Error("nothing was fetched: the scan failed")
	}
	if len(store.rows) != 0 || store.readTo != 0 {
		t.Errorf("stored %d rows and moved the cursor to %d", len(store.rows), store.readTo)
	}
}
