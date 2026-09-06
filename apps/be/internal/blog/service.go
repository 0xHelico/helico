package blog

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Store is what the service needs from persistence. The SQLite store implements it; tests
// may use anything that does.
type Store interface {
	// Upsert writes the post and reports whether it was new.
	Upsert(ctx context.Context, p Post) (created bool, err error)
	Get(ctx context.Context, slug string) (Post, error)
	// List returns up to limit posts newest first, starting after the cursor.
	List(ctx context.Context, limit int, after Cursor) ([]Post, error)
	Delete(ctx context.Context, slug string) error
}

// ListPage is one page of posts and the cursor for the next, empty when there is none.
type ListPage struct {
	Items      []Post
	NextCursor string
}

const (
	DefaultPageSize = 20
	MaxPageSize     = 100
)

// Service applies the rules: validation, rendering, timestamps, page sizes.
type Service struct {
	store Store
	now   func() time.Time
}

// NewService wires a store; time comes from the clock unless a test replaces it.
func NewService(store Store) *Service {
	return &Service{store: store, now: func() time.Time { return time.Now().UTC() }}
}

// WithClock replaces the clock, for tests.
func (s *Service) WithClock(now func() time.Time) *Service {
	s.now = now
	return s
}

// Save validates the draft, renders it, and writes it under the slug. Created reports whether
// the slug was new.
func (s *Service) Save(ctx context.Context, slug string, d Draft) (Post, bool, error) {
	if err := ValidateSlug(slug); err != nil {
		return Post{}, false, err
	}
	if err := d.Validate(); err != nil {
		return Post{}, false, err
	}
	html, err := Render(d.Markdown)
	if err != nil {
		return Post{}, false, err
	}
	now := s.now()
	published := now
	if d.PublishedAt != nil {
		published = d.PublishedAt.UTC()
	}
	tags := d.Tags
	if tags == nil {
		tags = []string{}
	}
	p := Post{
		Slug:           slug,
		Title:          strings.TrimSpace(d.Title),
		Summary:        strings.TrimSpace(d.Summary),
		Author:         strings.TrimSpace(d.Author),
		Cover:          d.Cover,
		Tags:           tags,
		Markdown:       d.Markdown,
		HTML:           html,
		ReadingMinutes: ReadingMinutes(d.Markdown),
		PublishedAt:    published.Truncate(time.Second),
		UpdatedAt:      now.Truncate(time.Second),
	}
	created, err := s.store.Upsert(ctx, p)
	if err != nil {
		return Post{}, false, fmt.Errorf("save %q: %w", slug, err)
	}
	return p, created, nil
}

// Get returns one post or ErrNotFound.
func (s *Service) Get(ctx context.Context, slug string) (Post, error) {
	if err := ValidateSlug(slug); err != nil {
		return Post{}, ErrNotFound
	}
	return s.store.Get(ctx, slug)
}

// List returns a page. A limit outside 1..MaxPageSize is clamped, not refused.
func (s *Service) List(ctx context.Context, limit int, cursor string) (ListPage, error) {
	if limit <= 0 {
		limit = DefaultPageSize
	}
	if limit > MaxPageSize {
		limit = MaxPageSize
	}
	after, err := DecodeCursor(cursor)
	if err != nil {
		return ListPage{}, &ValidationError{Field: "cursor", Msg: "not a cursor this API issued"}
	}
	// One more than asked, to learn whether a next page exists without a second query.
	items, err := s.store.List(ctx, limit+1, after)
	if err != nil {
		return ListPage{}, fmt.Errorf("list: %w", err)
	}
	page := ListPage{Items: items}
	if len(items) > limit {
		page.Items = items[:limit]
		last := page.Items[limit-1]
		page.NextCursor = Cursor{PublishedAt: last.PublishedAt, Slug: last.Slug}.Encode()
	}
	if page.Items == nil {
		page.Items = []Post{}
	}
	return page, nil
}

// Delete removes a post or returns ErrNotFound.
func (s *Service) Delete(ctx context.Context, slug string) error {
	if err := ValidateSlug(slug); err != nil {
		return ErrNotFound
	}
	return s.store.Delete(ctx, slug)
}

// ETag identifies a post's current version: the slug and the update time, hashed so the
// header stays short and reveals nothing.
func (p Post) ETag() string {
	sum := sha256.Sum256([]byte(p.Slug + "|" + strconv.FormatInt(p.UpdatedAt.Unix(), 10)))
	return `W/"` + hex.EncodeToString(sum[:8]) + `"`
}

// ETag for a page is the hash of its items' tags and cursor, so a changed post anywhere on
// the page changes it.
func (l ListPage) ETag() string {
	h := sha256.New()
	for _, p := range l.Items {
		h.Write([]byte(p.ETag()))
	}
	h.Write([]byte(l.NextCursor))
	return `W/"` + hex.EncodeToString(h.Sum(nil)[:8]) + `"`
}
