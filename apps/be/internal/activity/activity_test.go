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
}

func (f *fakeRPC) Head(context.Context) (uint64, error) {
	f.headCalls++
	return f.head, f.headErr
}
func (f *fakeRPC) Logs(_ context.Context, _ string, from, to uint64) ([]Event, error) {
	f.asked = append(f.asked, [2]uint64{from, to})
	return f.logs, f.logsErr
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
