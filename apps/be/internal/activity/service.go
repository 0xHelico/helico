package activity

import (
	"context"
	"fmt"
	"time"
)

// Store is what the service needs from a database, and no more.
type Store interface {
	ActivityCursor(ctx context.Context, account string) (readTo int64, checkedAt int64, err error)
	Activity(ctx context.Context, account string, limit int) ([]Event, error)
	SaveActivity(ctx context.Context, account string, events []Event, readTo, checkedAt int64) error
}

// Service answers "what did this account do" and asks the chain as rarely as it can.
type Service struct {
	store Store
	rpc   Reader
	// from is the first block worth scanning: the factory's own deployment. Nothing can predate the
	// contract that creates these accounts, so it is exact rather than a guess and it saves the
	// 485 million blocks before it.
	from uint64
	// fresh is how long a cursor is trusted without asking for the head again. An account moves
	// when the enclave acts, which is every five minutes at most.
	fresh time.Duration
	limit int
	now   func() time.Time
}

// NewService builds one. `from` is the factory's deployment block.
func NewService(store Store, rpc Reader, from uint64, fresh time.Duration, limit int) *Service {
	if limit <= 0 {
		limit = 50
	}
	return &Service{store: store, rpc: rpc, from: from, fresh: fresh, limit: limit, now: time.Now}
}

// Result is the answer and whether the chain had to be asked for it.
type Result struct {
	Events  []Event `json:"events"`
	ReadTo  int64   `json:"readTo"`
	Fetched bool    `json:"-"`
}

// For returns the account's history, newest first.
//
// **The read is forward-only.** The cursor says which block was last read; the next scan starts at
// the one after it. So a first visit costs one wide `eth_getLogs` and every visit after it costs a
// narrow one, or nothing at all while the cursor is fresh. The browser was paying for the wide scan
// every time, three times over, per visitor.
//
// **A failed scan serves what is already known.** An endpoint that will not answer is a reason to
// show yesterday's history, not a reason to show none — and the rows below the cursor are final, so
// there is nothing stale about them.
func (s *Service) For(ctx context.Context, account string) (Result, error) {
	account, err := Normalise(account)
	if err != nil {
		return Result{}, err
	}
	readTo, checkedAt, err := s.store.ActivityCursor(ctx, account)
	if err != nil {
		return Result{}, err
	}

	stale := s.now().Sub(time.Unix(checkedAt, 0)) >= s.fresh
	fetched := false
	if stale {
		head, err := s.rpc.Head(ctx)
		switch {
		case err != nil:
			// Serve what is known. The caller learns nothing was fetched.
		case head <= uint64(readTo):
			// Nothing new, and the cursor still moves so the next visitor is not charged for this.
			_ = s.store.SaveActivity(ctx, account, nil, readTo, s.now().Unix())
		default:
			start := s.from
			if readTo > 0 {
				start = uint64(readTo) + 1
			}
			events, err := s.rpc.Logs(ctx, account, start, head)
			if err == nil {
				if err := s.store.SaveActivity(ctx, account, events, int64(head), s.now().Unix()); err != nil {
					return Result{}, fmt.Errorf("save activity: %w", err)
				}
				readTo = int64(head)
				fetched = true
			}
		}
	}

	events, err := s.store.Activity(ctx, account, s.limit)
	if err != nil {
		return Result{}, err
	}
	return Result{Events: events, ReadTo: readTo, Fetched: fetched}, nil
}
