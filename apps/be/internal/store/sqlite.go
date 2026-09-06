// Package store keeps posts in one SQLite file. WAL mode lets readers run while a write is
// in flight; writes are serialised in-process so the busy timeout is rarely reached.
package store

import (
	"context"
	"database/sql"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	_ "modernc.org/sqlite"

	"github.com/0xHelico/helico/apps/be/internal/blog"
)

//go:embed migrations/*.sql
var migrations embed.FS

// SQLite is the store. Safe for concurrent use.
type SQLite struct {
	db    *sql.DB
	write sync.Mutex
}

// Open opens or creates the database at path, applies pending migrations, and returns the
// store. ":memory:" gives a private in-memory database, for tests.
func Open(ctx context.Context, path string) (*SQLite, error) {
	dsn := path
	if path != ":memory:" {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return nil, fmt.Errorf("create db dir: %w", err)
		}
		dsn = "file:" + path + "?_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(ON)"
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	if path == ":memory:" {
		// Every connection to :memory: is its own database; keep exactly one.
		db.SetMaxOpenConns(1)
	}
	s := &SQLite{db: db}
	if err := s.migrate(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

// Close releases the database.
func (s *SQLite) Close() error { return s.db.Close() }

// migrate applies every embedded migration not yet recorded, in file order.
func (s *SQLite) migrate(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT`); err != nil {
		return fmt.Errorf("migrations table: %w", err)
	}
	entries, err := fs.ReadDir(migrations, "migrations")
	if err != nil {
		return fmt.Errorf("read migrations: %w", err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Strings(names)
	for _, name := range names {
		var applied int
		if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM schema_migrations WHERE name = ?`, name).Scan(&applied); err != nil {
			return fmt.Errorf("check migration %s: %w", name, err)
		}
		if applied > 0 {
			continue
		}
		body, err := migrations.ReadFile("migrations/" + name)
		if err != nil {
			return fmt.Errorf("read migration %s: %w", name, err)
		}
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return fmt.Errorf("begin migration %s: %w", name, err)
		}
		if _, err := tx.ExecContext(ctx, string(body)); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("apply migration %s: %w", name, err)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`, name, time.Now().Unix()); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("record migration %s: %w", name, err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration %s: %w", name, err)
		}
	}
	return nil
}

const columns = `slug, title, summary, author, cover, tags, markdown, html, reading_minutes, published_at, updated_at`

// Upsert inserts the post or replaces the row with the same slug.
func (s *SQLite) Upsert(ctx context.Context, p blog.Post) (bool, error) {
	tags, err := json.Marshal(p.Tags)
	if err != nil {
		return false, fmt.Errorf("encode tags: %w", err)
	}
	s.write.Lock()
	defer s.write.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var existing int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM posts WHERE slug = ?`, p.Slug).Scan(&existing); err != nil {
		return false, fmt.Errorf("check: %w", err)
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO posts (`+columns+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(slug) DO UPDATE SET
			title = excluded.title, summary = excluded.summary, author = excluded.author,
			cover = excluded.cover, tags = excluded.tags, markdown = excluded.markdown,
			html = excluded.html, reading_minutes = excluded.reading_minutes,
			published_at = excluded.published_at, updated_at = excluded.updated_at`,
		p.Slug, p.Title, p.Summary, p.Author, p.Cover, string(tags), p.Markdown, p.HTML,
		p.ReadingMinutes, p.PublishedAt.Unix(), p.UpdatedAt.Unix())
	if err != nil {
		return false, fmt.Errorf("upsert: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("commit: %w", err)
	}
	return existing == 0, nil
}

// Get returns the post with the slug, or blog.ErrNotFound.
func (s *SQLite) Get(ctx context.Context, slug string) (blog.Post, error) {
	row := s.db.QueryRowContext(ctx, `SELECT `+columns+` FROM posts WHERE slug = ?`, slug)
	p, err := scan(row)
	if errors.Is(err, sql.ErrNoRows) {
		return blog.Post{}, blog.ErrNotFound
	}
	return p, err
}

// List returns up to limit posts newest first, strictly after the cursor when one is given.
func (s *SQLite) List(ctx context.Context, limit int, after blog.Cursor) ([]blog.Post, error) {
	var rows *sql.Rows
	var err error
	if after.IsZero() {
		rows, err = s.db.QueryContext(ctx, `SELECT `+columns+` FROM posts ORDER BY published_at DESC, slug DESC LIMIT ?`, limit)
	} else {
		rows, err = s.db.QueryContext(ctx, `SELECT `+columns+` FROM posts WHERE (published_at, slug) < (?, ?) ORDER BY published_at DESC, slug DESC LIMIT ?`,
			after.PublishedAt.Unix(), after.Slug, limit)
	}
	if err != nil {
		return nil, fmt.Errorf("list: %w", err)
	}
	defer rows.Close()
	posts := make([]blog.Post, 0, limit)
	for rows.Next() {
		p, err := scan(rows)
		if err != nil {
			return nil, err
		}
		posts = append(posts, p)
	}
	return posts, rows.Err()
}

// Delete removes the post, or returns blog.ErrNotFound.
func (s *SQLite) Delete(ctx context.Context, slug string) error {
	s.write.Lock()
	defer s.write.Unlock()
	res, err := s.db.ExecContext(ctx, `DELETE FROM posts WHERE slug = ?`, slug)
	if err != nil {
		return fmt.Errorf("delete: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return blog.ErrNotFound
	}
	return nil
}

type scanner interface{ Scan(dest ...any) error }

func scan(r scanner) (blog.Post, error) {
	var p blog.Post
	var tags string
	var published, updated int64
	if err := r.Scan(&p.Slug, &p.Title, &p.Summary, &p.Author, &p.Cover, &tags, &p.Markdown, &p.HTML, &p.ReadingMinutes, &published, &updated); err != nil {
		return blog.Post{}, err
	}
	if err := json.Unmarshal([]byte(tags), &p.Tags); err != nil {
		return blog.Post{}, fmt.Errorf("decode tags for %s: %w", p.Slug, err)
	}
	if p.Tags == nil {
		p.Tags = []string{}
	}
	p.PublishedAt = time.Unix(published, 0).UTC()
	p.UpdatedAt = time.Unix(updated, 0).UTC()
	return p, nil
}
