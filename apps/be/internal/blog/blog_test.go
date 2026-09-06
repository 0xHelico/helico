package blog

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestValidateSlug(t *testing.T) {
	for _, ok := range []string{"a", "hello-world", "post-2", "x1-y2-z3"} {
		if err := ValidateSlug(ok); err != nil {
			t.Errorf("%q should be valid: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "Hello", "hello world", "-lead", "trail-", "double--hyphen", strings.Repeat("a", 121), "ünïcode"} {
		if err := ValidateSlug(bad); err == nil {
			t.Errorf("%q should be invalid", bad)
		}
	}
}

func TestDraftValidate(t *testing.T) {
	good := Draft{Title: "T", Author: "A", Markdown: "body", Tags: []string{"one", "two"}}
	if err := good.Validate(); err != nil {
		t.Fatalf("good draft: %v", err)
	}
	cases := map[string]Draft{
		"no title":    {Author: "A", Markdown: "b"},
		"no author":   {Title: "T", Markdown: "b"},
		"no markdown": {Title: "T", Author: "A", Markdown: "  "},
		"bad tag":     {Title: "T", Author: "A", Markdown: "b", Tags: []string{"Bad Tag"}},
		"bad cover":   {Title: "T", Author: "A", Markdown: "b", Cover: "javascript:alert(1)"},
		"long title":  {Title: strings.Repeat("t", 201), Author: "A", Markdown: "b"},
	}
	for name, d := range cases {
		var verr *ValidationError
		if err := d.Validate(); err == nil || !asValidation(err, &verr) {
			t.Errorf("%s: want a ValidationError, got %v", name, err)
		}
	}
}

func asValidation(err error, target **ValidationError) bool {
	v, ok := err.(*ValidationError)
	if ok {
		*target = v
	}
	return ok
}

func TestRender(t *testing.T) {
	html, err := Render("# Title\n\nA *word* and a | table |\n|---|---|\n| a | b |\n\n<script>alert(1)</script>\n")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`<h1 id="title">Title</h1>`, "<em>word</em>", "<table>"} {
		if !strings.Contains(html, want) {
			t.Errorf("rendered HTML lacks %q:\n%s", want, html)
		}
	}
	if strings.Contains(html, "<script>") {
		t.Errorf("raw HTML must be dropped:\n%s", html)
	}
}

func TestReadingMinutes(t *testing.T) {
	if got := ReadingMinutes(""); got != 1 {
		t.Errorf("empty: got %d, want 1", got)
	}
	if got := ReadingMinutes(strings.Repeat("word ", 238)); got != 1 {
		t.Errorf("238 words: got %d, want 1", got)
	}
	if got := ReadingMinutes(strings.Repeat("word ", 239)); got != 2 {
		t.Errorf("239 words: got %d, want 2", got)
	}
	if got := ReadingMinutes(strings.Repeat("word ", 1600)); got != 7 {
		t.Errorf("1600 words: got %d, want 7", got)
	}
}

func TestCursorRoundTrip(t *testing.T) {
	c := Cursor{PublishedAt: time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC), Slug: "a-post"}
	back, err := DecodeCursor(c.Encode())
	if err != nil {
		t.Fatal(err)
	}
	if !back.PublishedAt.Equal(c.PublishedAt) || back.Slug != c.Slug {
		t.Errorf("round trip: got %+v, want %+v", back, c)
	}
	if empty, err := DecodeCursor(""); err != nil || !empty.IsZero() {
		t.Errorf("empty cursor: %+v, %v", empty, err)
	}
	for _, bad := range []string{"not-base64!", "YWJj", "MTIzfEJhZCBTbHVn"} {
		if _, err := DecodeCursor(bad); err == nil {
			t.Errorf("%q should not decode", bad)
		}
	}
}

// memStore is enough of a Store for the service's own rules.
type memStore struct{ posts map[string]Post }

func (m *memStore) Upsert(_ context.Context, p Post) (bool, error) {
	_, existed := m.posts[p.Slug]
	m.posts[p.Slug] = p
	return !existed, nil
}

func (m *memStore) Get(_ context.Context, slug string) (Post, error) {
	p, ok := m.posts[slug]
	if !ok {
		return Post{}, ErrNotFound
	}
	return p, nil
}

func (m *memStore) List(_ context.Context, limit int, after Cursor) ([]Post, error) {
	var out []Post
	for _, p := range m.posts {
		if !after.IsZero() && !(p.PublishedAt.Before(after.PublishedAt) || (p.PublishedAt.Equal(after.PublishedAt) && p.Slug < after.Slug)) {
			continue
		}
		out = append(out, p)
	}
	for i := 0; i < len(out); i++ {
		for j := i + 1; j < len(out); j++ {
			if out[j].PublishedAt.After(out[i].PublishedAt) || (out[j].PublishedAt.Equal(out[i].PublishedAt) && out[j].Slug > out[i].Slug) {
				out[i], out[j] = out[j], out[i]
			}
		}
	}
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (m *memStore) Delete(_ context.Context, slug string) error {
	if _, ok := m.posts[slug]; !ok {
		return ErrNotFound
	}
	delete(m.posts, slug)
	return nil
}

func TestServiceSaveAndList(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	svc := NewService(&memStore{posts: map[string]Post{}}).WithClock(func() time.Time { return now })

	p, created, err := svc.Save(ctx, "first", Draft{Title: " First ", Author: "Helico", Markdown: "Hello **world**"})
	if err != nil || !created {
		t.Fatalf("save: %v created=%v", err, created)
	}
	if p.Title != "First" || !strings.Contains(p.HTML, "<strong>world</strong>") || p.ReadingMinutes != 1 || !p.PublishedAt.Equal(now) {
		t.Errorf("derived fields: %+v", p)
	}
	if _, created, _ := svc.Save(ctx, "first", Draft{Title: "First", Author: "Helico", Markdown: "again"}); created {
		t.Error("second save of the same slug must not report created")
	}
	if _, _, err := svc.Save(ctx, "Bad Slug", Draft{Title: "T", Author: "A", Markdown: "b"}); err == nil {
		t.Error("a bad slug must be refused")
	}

	for i, slug := range []string{"second", "third", "fourth"} {
		at := now.Add(time.Duration(i+1) * time.Hour)
		if _, _, err := svc.Save(ctx, slug, Draft{Title: slug, Author: "A", Markdown: "b", PublishedAt: &at}); err != nil {
			t.Fatal(err)
		}
	}
	page, err := svc.List(ctx, 2, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 2 || page.Items[0].Slug != "fourth" || page.Items[1].Slug != "third" || page.NextCursor == "" {
		t.Errorf("first page: %+v", page)
	}
	page2, err := svc.List(ctx, 2, page.NextCursor)
	if err != nil {
		t.Fatal(err)
	}
	if len(page2.Items) != 2 || page2.Items[0].Slug != "second" || page2.Items[1].Slug != "first" || page2.NextCursor != "" {
		t.Errorf("second page: %+v", page2)
	}
	if _, err := svc.List(ctx, 2, "garbage!"); err == nil {
		t.Error("a bad cursor must be refused")
	}
	if page.ETag() == page2.ETag() {
		t.Error("different pages must carry different ETags")
	}
	if err := svc.Delete(ctx, "first"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Get(ctx, "first"); err != ErrNotFound {
		t.Errorf("after delete: %v", err)
	}
}
