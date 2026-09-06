package httpapi

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/0xHelico/helico/apps/be/internal/blog"
	"github.com/0xHelico/helico/apps/be/internal/store"
)

const token = "test-token"

func newServer(t *testing.T, adminToken string) *httptest.Server {
	t.Helper()
	db, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "api.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	h := New(blog.NewService(db), Options{AdminToken: adminToken, CORSOrigins: []string{"http://localhost:4321"}, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv
}

func do(t *testing.T, method, url string, body any, headers map[string]string) (*http.Response, []byte) {
	t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, url, rd)
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	out, _ := io.ReadAll(res.Body)
	return res, out
}

func TestHealth(t *testing.T) {
	srv := newServer(t, token)
	res, body := do(t, "GET", srv.URL+"/healthz", nil, nil)
	if res.StatusCode != 200 || !strings.Contains(string(body), `"ok"`) {
		t.Fatalf("health: %d %s", res.StatusCode, body)
	}
	if res.Header.Get("X-Request-Id") == "" {
		t.Error("every response carries a request id")
	}
}

func TestWritesNeedTheToken(t *testing.T) {
	srv := newServer(t, token)
	draft := map[string]any{"title": "T", "author": "A", "markdown": "b"}
	if res, _ := do(t, "PUT", srv.URL+"/api/posts/one", draft, nil); res.StatusCode != 401 {
		t.Errorf("no token: %d", res.StatusCode)
	}
	if res, _ := do(t, "PUT", srv.URL+"/api/posts/one", draft, map[string]string{"Authorization": "Bearer wrong"}); res.StatusCode != 401 {
		t.Errorf("wrong token: %d", res.StatusCode)
	}
	if res, _ := do(t, "DELETE", srv.URL+"/api/posts/one", nil, nil); res.StatusCode != 401 {
		t.Errorf("delete without token: %d", res.StatusCode)
	}
}

func TestWritesDisabledWithoutAToken(t *testing.T) {
	srv := newServer(t, "")
	res, body := do(t, "PUT", srv.URL+"/api/posts/one", map[string]any{"title": "T", "author": "A", "markdown": "b"}, map[string]string{"Authorization": "Bearer anything"})
	if res.StatusCode != 503 || !strings.Contains(string(body), "BE_ADMIN_TOKEN") {
		t.Errorf("writes disabled: %d %s", res.StatusCode, body)
	}
}

func TestLifecycle(t *testing.T) {
	srv := newServer(t, token)
	auth := map[string]string{"Authorization": "Bearer " + token}

	res, body := do(t, "GET", srv.URL+"/api/posts", nil, nil)
	if res.StatusCode != 200 || strings.TrimSpace(string(body)) != `{"items":[],"next_cursor":null}` {
		t.Fatalf("empty list: %d %s", res.StatusCode, body)
	}

	res, body = do(t, "PUT", srv.URL+"/api/posts/one", map[string]any{"title": "One", "author": "Helico", "markdown": "# One\n\nHello **there**", "tags": []string{"a"}, "published_at": "2026-09-06T10:00:00Z"}, auth)
	if res.StatusCode != 201 || res.Header.Get("Location") != "/api/posts/one" {
		t.Fatalf("create: %d %s", res.StatusCode, body)
	}
	if res, _ := do(t, "PUT", srv.URL+"/api/posts/one", map[string]any{"title": "One again", "author": "Helico", "markdown": "changed"}, auth); res.StatusCode != 200 {
		t.Errorf("replace: %d", res.StatusCode)
	}
	if res, body := do(t, "PUT", srv.URL+"/api/posts/bad", map[string]any{"title": "", "author": "A", "markdown": "b"}, auth); res.StatusCode != 422 || !strings.Contains(string(body), "title") {
		t.Errorf("validation: %d %s", res.StatusCode, body)
	}
	if res, _ := do(t, "PUT", srv.URL+"/api/posts/one", map[string]any{"title": "T", "author": "A", "markdown": "b", "unknown": 1}, auth); res.StatusCode != 400 {
		t.Errorf("unknown field: %d", res.StatusCode)
	}

	res, body = do(t, "GET", srv.URL+"/api/posts/one", nil, nil)
	if res.StatusCode != 200 || res.Header.Get("ETag") == "" || !strings.Contains(string(body), `"html":"<p>changed</p>`) {
		t.Fatalf("get: %d etag=%q %s", res.StatusCode, res.Header.Get("ETag"), body)
	}
	if res.Header.Get("Content-Type") != "application/json; charset=utf-8" || res.Header.Get("Cache-Control") == "" {
		t.Errorf("headers: %v", res.Header)
	}
	etag := res.Header.Get("ETag")
	if res, _ := do(t, "GET", srv.URL+"/api/posts/one", nil, map[string]string{"If-None-Match": etag}); res.StatusCode != 304 {
		t.Errorf("conditional get: %d", res.StatusCode)
	}

	for _, slug := range []string{"two", "three"} {
		if res, _ := do(t, "PUT", srv.URL+"/api/posts/"+slug, map[string]any{"title": slug, "author": "A", "markdown": "b"}, auth); res.StatusCode != 201 {
			t.Fatalf("create %s: %d", slug, res.StatusCode)
		}
	}
	res, body = do(t, "GET", srv.URL+"/api/posts?limit=2", nil, nil)
	var page struct {
		Items      []map[string]any `json:"items"`
		NextCursor *string          `json:"next_cursor"`
	}
	if err := json.Unmarshal(body, &page); err != nil || res.StatusCode != 200 {
		t.Fatalf("list: %d %v %s", res.StatusCode, err, body)
	}
	if len(page.Items) != 2 || page.NextCursor == nil {
		t.Fatalf("page 1: %+v", page)
	}
	if _, has := page.Items[0]["html"]; has {
		t.Error("list items must not carry the body")
	}
	res, body = do(t, "GET", srv.URL+"/api/posts?limit=2&cursor="+*page.NextCursor, nil, nil)
	if err := json.Unmarshal(body, &page); err != nil || len(page.Items) != 1 || page.NextCursor != nil {
		t.Fatalf("page 2: %d %v %s", res.StatusCode, err, body)
	}
	if res, _ := do(t, "GET", srv.URL+"/api/posts?limit=0", nil, nil); res.StatusCode != 400 {
		t.Errorf("bad limit: %d", res.StatusCode)
	}
	if res, _ := do(t, "GET", srv.URL+"/api/posts?cursor=nope!", nil, nil); res.StatusCode != 422 {
		t.Errorf("bad cursor: %d", res.StatusCode)
	}

	if res, _ := do(t, "DELETE", srv.URL+"/api/posts/one", nil, auth); res.StatusCode != 204 {
		t.Errorf("delete: %d", res.StatusCode)
	}
	res, body = do(t, "GET", srv.URL+"/api/posts/one", nil, nil)
	if res.StatusCode != 404 || res.Header.Get("Content-Type") != "application/problem+json; charset=utf-8" || !strings.Contains(string(body), `"status":404`) {
		t.Errorf("after delete: %d %s %s", res.StatusCode, res.Header.Get("Content-Type"), body)
	}
	if res, _ := do(t, "GET", srv.URL+"/nothing", nil, nil); res.StatusCode != 404 {
		t.Errorf("unknown route: %d", res.StatusCode)
	}
}

func TestGzipAndCORS(t *testing.T) {
	srv := newServer(t, token)
	auth := map[string]string{"Authorization": "Bearer " + token}
	big := strings.Repeat("A paragraph of text that will make the body larger than one kilobyte. ", 40)
	if res, _ := do(t, "PUT", srv.URL+"/api/posts/big", map[string]any{"title": "Big", "author": "A", "markdown": big}, auth); res.StatusCode != 201 {
		t.Fatalf("create big: %d", res.StatusCode)
	}
	res, body := do(t, "GET", srv.URL+"/api/posts/big", nil, map[string]string{"Accept-Encoding": "gzip"})
	if res.Header.Get("Content-Encoding") != "gzip" {
		t.Fatalf("big JSON should be gzipped: %v", res.Header)
	}
	zr, err := gzip.NewReader(bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	plain, _ := io.ReadAll(zr)
	if !strings.Contains(string(plain), `"slug":"big"`) {
		t.Errorf("gunzipped body: %s", plain[:80])
	}
	res, _ = do(t, "GET", srv.URL+"/healthz", nil, map[string]string{"Accept-Encoding": "gzip"})
	if res.Header.Get("Content-Encoding") == "gzip" {
		t.Error("a tiny body must not be gzipped")
	}
	res, _ = do(t, "OPTIONS", srv.URL+"/api/posts", nil, map[string]string{"Origin": "http://localhost:4321"})
	if res.StatusCode != 204 || res.Header.Get("Access-Control-Allow-Origin") != "http://localhost:4321" {
		t.Errorf("preflight: %d %v", res.StatusCode, res.Header)
	}
	res, _ = do(t, "GET", srv.URL+"/api/posts", nil, map[string]string{"Origin": "https://evil.example"})
	if res.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Error("an unknown origin must not be allowed")
	}
}
