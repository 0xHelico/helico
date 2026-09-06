// Package content seeds the store from Markdown files with YAML front matter. The files are
// the source of truth for the posts that ship with the repository; the API is for the rest.
package content

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/0xHelico/helico/apps/be/internal/blog"
)

// FrontMatter is the header of a post file. The slug is the file name without ".md".
type FrontMatter struct {
	Title       string    `yaml:"title"`
	Summary     string    `yaml:"summary"`
	Author      string    `yaml:"author"`
	Cover       string    `yaml:"cover"`
	Tags        []string  `yaml:"tags"`
	PublishedAt time.Time `yaml:"published_at"`
}

// Parse splits a file into its front matter and Markdown body.
func Parse(raw []byte) (FrontMatter, string, error) {
	const fence = "---"
	body := strings.TrimPrefix(string(raw), "\uFEFF")
	if !strings.HasPrefix(body, fence) {
		return FrontMatter{}, "", errors.New("missing front matter")
	}
	rest := body[len(fence):]
	end := strings.Index(rest, "\n"+fence)
	if end < 0 {
		return FrontMatter{}, "", errors.New("unterminated front matter")
	}
	var fm FrontMatter
	if err := yaml.Unmarshal([]byte(rest[:end]), &fm); err != nil {
		return FrontMatter{}, "", fmt.Errorf("front matter: %w", err)
	}
	md := strings.TrimLeft(rest[end+len(fence)+1:], "\r\n")
	return fm, md, nil
}

// Seed reads every *.md in dir and saves the ones that differ from what the store holds.
// It returns how many were written. A missing directory seeds nothing and is not an error.
func Seed(ctx context.Context, dir string, svc *blog.Service) (int, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("read %s: %w", dir, err)
	}
	written := 0
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".md" {
			continue
		}
		slug := strings.TrimSuffix(e.Name(), ".md")
		raw, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			return written, fmt.Errorf("read %s: %w", e.Name(), err)
		}
		fm, md, err := Parse(raw)
		if err != nil {
			return written, fmt.Errorf("%s: %w", e.Name(), err)
		}
		draft := blog.Draft{Title: fm.Title, Summary: fm.Summary, Author: fm.Author, Cover: fm.Cover, Tags: fm.Tags, Markdown: md}
		if !fm.PublishedAt.IsZero() {
			at := fm.PublishedAt.UTC()
			draft.PublishedAt = &at
		}
		if existing, err := svc.Get(ctx, slug); err == nil && unchanged(existing, draft) {
			continue
		}
		if _, _, err := svc.Save(ctx, slug, draft); err != nil {
			return written, fmt.Errorf("%s: %w", e.Name(), err)
		}
		written++
	}
	return written, nil
}

// unchanged reports whether the stored post already says what the file says, so a restart
// does not rewrite every row and bump every ETag.
func unchanged(p blog.Post, d blog.Draft) bool {
	tags := d.Tags
	if tags == nil {
		tags = []string{}
	}
	published := p.PublishedAt
	if d.PublishedAt != nil {
		published = d.PublishedAt.Truncate(time.Second)
	}
	return p.Title == strings.TrimSpace(d.Title) && p.Summary == strings.TrimSpace(d.Summary) &&
		p.Author == strings.TrimSpace(d.Author) && p.Cover == d.Cover && slices.Equal(p.Tags, tags) &&
		p.Markdown == d.Markdown && p.PublishedAt.Equal(published)
}
