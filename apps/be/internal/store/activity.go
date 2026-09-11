package store

import (
	"context"
	"fmt"

	"github.com/0xHelico/helico/apps/be/internal/activity"
)

// ActivityCursor is how far this account's log has been read, and when that was established.
// A zero readTo means never.
func (s *SQLite) ActivityCursor(ctx context.Context, account string) (readTo int64, checkedAt int64, err error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT read_to, checked_at FROM account_activity_cursor WHERE account = ?`, account)
	switch err := row.Scan(&readTo, &checkedAt); err {
	case nil:
		return readTo, checkedAt, nil
	default:
		// No row is the ordinary case for an account nobody has looked at, and it is not an error.
		return 0, 0, nil
	}
}

// Activity returns what this account did, newest first, at most limit rows.
func (s *SQLite) Activity(ctx context.Context, account string, limit int) ([]activity.Event, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT block, block_time, log_index, kind, tx, pool, asset, amount, supplied, allowed, agent
		   FROM account_activity WHERE account = ?
		  ORDER BY block DESC, log_index DESC LIMIT ?`, account, limit)
	if err != nil {
		return nil, fmt.Errorf("read activity: %w", err)
	}
	defer rows.Close()
	out := make([]activity.Event, 0, limit)
	for rows.Next() {
		var e activity.Event
		var supplied, allowed int
		if err := rows.Scan(&e.Block, &e.BlockTime, &e.LogIndex, &e.Kind, &e.Tx, &e.Pool, &e.Asset,
			&e.Amount, &supplied, &allowed, &e.Agent); err != nil {
			return nil, fmt.Errorf("scan activity: %w", err)
		}
		e.Supplied = supplied == 1
		e.Allowed = allowed == 1
		out = append(out, e)
	}
	return out, rows.Err()
}

// SaveActivity writes the events and moves the cursor, in one transaction.
//
// Both or neither: a cursor moved past rows that failed to insert would skip them for ever, and
// this is the one place that can happen. `INSERT OR IGNORE` rather than plain insert because two
// visitors can ask at the same moment and read the same block twice — the primary key makes the
// second write a no-op instead of an error.
func (s *SQLite) SaveActivity(ctx context.Context, account string, events []activity.Event, readTo, checkedAt int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	for _, e := range events {
		supplied, allowed := 0, 0
		if e.Supplied {
			supplied = 1
		}
		if e.Allowed {
			allowed = 1
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT OR IGNORE INTO account_activity
			   (account, block, block_time, log_index, kind, tx, pool, asset, amount, supplied, allowed, agent)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			account, int64(e.Block), int64(e.BlockTime), int64(e.LogIndex), string(e.Kind), e.Tx,
			e.Pool, e.Asset, e.Amount, supplied, allowed, e.Agent); err != nil {
			return fmt.Errorf("insert activity: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO account_activity_cursor (account, read_to, checked_at) VALUES (?, ?, ?)
		 ON CONFLICT(account) DO UPDATE SET read_to = excluded.read_to, checked_at = excluded.checked_at`,
		account, readTo, checkedAt); err != nil {
		return fmt.Errorf("move cursor: %w", err)
	}
	return tx.Commit()
}
