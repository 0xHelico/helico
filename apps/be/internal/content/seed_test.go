package content

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/0xHelico/helico/apps/be/internal/blog"
	"github.com/0xHelico/helico/apps/be/internal/store"
)

const sample = `---
title: "Hello"
summary: "A summary"
author: "Helico"
tags: ["one", "two"]
published_at: 2026-09-06T08:00:00Z
---

# Heading

Body text.
`

func TestParse(t *testing.T) {
	fm, md, err := Parse([]byte(sample))
	if err != nil {
		t.Fatal(err)
	}
	if fm.Title != "Hello" || fm.Author != "Helico" || len(fm.Tags) != 2 || fm.PublishedAt.Hour() != 8 {
		t.Errorf("front matter: %+v", fm)
	}
	if md != "# Heading\n\nBody text.\n" {
		t.Errorf("markdown: %q", md)
	}
	if _, _, err := Parse([]byte("no front matter")); err == nil {
		t.Error("missing front matter must be an error")
	}
}

func TestSeedWritesOnceThenSkips(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "hello.md"), []byte(sample), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("ignored"), 0o644); err != nil {
		t.Fatal(err)
	}
	db, err := store.Open(ctx, filepath.Join(dir, "db.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	svc := blog.NewService(db)

	n, err := Seed(ctx, dir, svc)
	if err != nil || n != 1 {
		t.Fatalf("first seed: n=%d err=%v", n, err)
	}
	p, err := svc.Get(ctx, "hello")
	if err != nil {
		t.Fatal(err)
	}
	if p.Title != "Hello" || !p.PublishedAt.Equal(time.Date(2026, 9, 6, 8, 0, 0, 0, time.UTC)) {
		t.Errorf("seeded post: %+v", p)
	}
	n, err = Seed(ctx, dir, svc)
	if err != nil || n != 0 {
		t.Fatalf("second seed must skip: n=%d err=%v", n, err)
	}
	if n, err := Seed(ctx, filepath.Join(dir, "missing"), svc); err != nil || n != 0 {
		t.Errorf("missing dir: n=%d err=%v", n, err)
	}
}
