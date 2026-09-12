package store

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/0xHelico/helico/apps/be/internal/activity"
)

// **The property `0005_activity_rescan.sql` depends on.** Clearing the cursor makes every account
// scan its whole range again, over blocks whose rows are already stored. That is only safe if a
// second save of the same logs adds the ones that were never asked for and leaves the rest alone.
//
// The migration cannot be tested directly: it runs at Open, before a test can put a cursor there
// to be cleared. What can be tested is the mechanism it relies on, which is the part that would
// actually be wrong — a primary key that did not hold, or an insert that was not OR IGNORE, would
// turn the rescan into duplicated history or a failed read.
func TestARescanAddsTheNewRowsAndDuplicatesNothing(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "rescan.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })

	const account = "0x0acdfa21a3cd075aee6583c8a8069f86ad3e4a39"
	// What the reader stored before it understood transfers: the account's own events only.
	before := []activity.Event{
		{Block: 503_787_461, LogIndex: 8, BlockTime: 1_789_063_118, Kind: activity.KindVenue, Tx: "0x06", Pool: "0xbba", Allowed: true},
		{Block: 504_034_368, LogIndex: 4, BlockTime: 1_789_125_923, Kind: activity.KindAgent, Tx: "0xce", Agent: "0x98c"},
		{Block: 504_035_561, LogIndex: 18, BlockTime: 1_789_126_222, Kind: activity.KindMoved, Tx: "0x06", Amount: "490081", Supplied: true},
	}
	if err := s.SaveActivity(ctx, account, before, 504_100_000, 1_789_200_000); err != nil {
		t.Fatal(err)
	}

	// The rescan: the same range, now carrying the transfers as well. The deposit is the row the
	// whole migration exists for — nothing a Helico contract emits says the account was funded.
	again := append([]activity.Event{
		{Block: 504_019_200, LogIndex: 0, BlockTime: 1_789_122_133, Kind: activity.KindIn, Tx: "0x87", Amount: "500081", Supplied: true},
		{Block: 504_035_561, LogIndex: 1, BlockTime: 1_789_126_222, Kind: activity.KindOut, Tx: "0x06", Amount: "490081"},
	}, before...)
	if err := s.SaveActivity(ctx, account, again, 504_100_000, 1_789_200_001); err != nil {
		t.Fatalf("a rescan over stored blocks failed: %v", err)
	}

	rows, err := s.Activity(ctx, account, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 5 {
		t.Fatalf("%d rows after the rescan, want the three already held plus the two new ones", len(rows))
	}
	kinds := map[activity.Kind]int{}
	for _, r := range rows {
		kinds[r.Kind]++
	}
	for kind, want := range map[activity.Kind]int{
		activity.KindVenue: 1,
		activity.KindAgent: 1,
		activity.KindMoved: 1,
		activity.KindIn:    1,
		activity.KindOut:   1,
	} {
		if kinds[kind] != want {
			t.Errorf("%s appears %d times, want %d", kind, kinds[kind], want)
		}
	}

	// And the deposit came back with its figure and its date, which is what the value line folds.
	var deposit *activity.Event
	for i := range rows {
		if rows[i].Kind == activity.KindIn {
			deposit = &rows[i]
		}
	}
	if deposit == nil {
		t.Fatal("the deposit is not there")
	}
	if deposit.Amount != "500081" || deposit.BlockTime != 1_789_122_133 {
		t.Errorf("deposit = %s at %d", deposit.Amount, deposit.BlockTime)
	}
}

// The cursor still only moves forward, which the migration resets rather than contradicts.
func TestTheCursorIsWhatTheMigrationClears(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "cursor.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })

	const account = "0x0acdfa21a3cd075aee6583c8a8069f86ad3e4a39"
	readTo, _, err := s.ActivityCursor(ctx, account)
	if err != nil || readTo != 0 {
		t.Fatalf("an account nobody has read has cursor %d, %v", readTo, err)
	}
	if err := s.SaveActivity(ctx, account, nil, 504_100_000, 1_789_200_000); err != nil {
		t.Fatal(err)
	}
	if readTo, _, _ = s.ActivityCursor(ctx, account); readTo != 504_100_000 {
		t.Fatalf("cursor %d", readTo)
	}
	// Which is exactly the state the migration deletes: a watermark at the head, over a history
	// that predates the reader knowing about transfers.
	if _, err := s.db.ExecContext(ctx, `DELETE FROM account_activity_cursor`); err != nil {
		t.Fatal(err)
	}
	if readTo, _, _ = s.ActivityCursor(ctx, account); readTo != 0 {
		t.Fatalf("cursor %d after the delete, want a full rescan", readTo)
	}
}
