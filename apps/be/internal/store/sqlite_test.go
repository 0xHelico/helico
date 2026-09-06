package store

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/0xHelico/helico/apps/be/internal/blog"
)

func open(t *testing.T) *SQLite {
	t.Helper()
	s, err := Open(context.Background(), filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func post(slug string, at time.Time) blog.Post {
	return blog.Post{Slug: slug, Title: "T " + slug, Author: "A", Tags: []string{"t"}, Markdown: "m", HTML: "<p>m</p>", ReadingMinutes: 1, PublishedAt: at, UpdatedAt: at}
}

func TestMigrateIsIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "m.db")
	for i := 0; i < 2; i++ {
		s, err := Open(context.Background(), path)
		if err != nil {
			t.Fatalf("open %d: %v", i, err)
		}
		_ = s.Close()
	}
}

func TestUpsertGetDelete(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	at := time.Date(2026, 9, 6, 10, 0, 0, 0, time.UTC)

	created, err := s.Upsert(ctx, post("a", at))
	if err != nil || !created {
		t.Fatalf("insert: %v created=%v", err, created)
	}
	p := post("a", at)
	p.Title = "changed"
	created, err = s.Upsert(ctx, p)
	if err != nil || created {
		t.Fatalf("update: %v created=%v", err, created)
	}
	got, err := s.Get(ctx, "a")
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != "changed" || got.Tags[0] != "t" || !got.PublishedAt.Equal(at) || got.HTML != "<p>m</p>" {
		t.Errorf("round trip: %+v", got)
	}
	if _, err := s.Get(ctx, "missing"); !errors.Is(err, blog.ErrNotFound) {
		t.Errorf("missing: %v", err)
	}
	if err := s.Delete(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(ctx, "a"); !errors.Is(err, blog.ErrNotFound) {
		t.Errorf("second delete: %v", err)
	}
}

func TestListKeyset(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	base := time.Date(2026, 9, 6, 10, 0, 0, 0, time.UTC)
	// Two posts share a timestamp, so the slug breaks the tie.
	for _, c := range []struct {
		slug string
		at   time.Time
	}{{"a", base}, {"b", base}, {"c", base.Add(time.Hour)}, {"d", base.Add(2 * time.Hour)}} {
		if _, err := s.Upsert(ctx, post(c.slug, c.at)); err != nil {
			t.Fatal(err)
		}
	}
	first, err := s.List(ctx, 3, blog.Cursor{})
	if err != nil {
		t.Fatal(err)
	}
	if got := slugs(first); got != "d,c,b" {
		t.Errorf("first page: %s", got)
	}
	last := first[len(first)-1]
	rest, err := s.List(ctx, 3, blog.Cursor{PublishedAt: last.PublishedAt, Slug: last.Slug})
	if err != nil {
		t.Fatal(err)
	}
	if got := slugs(rest); got != "a" {
		t.Errorf("second page: %s", got)
	}
}

func slugs(ps []blog.Post) string {
	out := ""
	for i, p := range ps {
		if i > 0 {
			out += ","
		}
		out += p.Slug
	}
	return out
}
