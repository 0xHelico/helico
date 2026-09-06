// Package httpapi exposes the blog over HTTP: five routes, JSON in and out, problem+json for
// errors, ETags for caches. Everything about posts themselves lives in the blog package.
package httpapi

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/0xHelico/helico/apps/be/internal/blog"
	"github.com/0xHelico/helico/apps/be/internal/chat"
	"github.com/0xHelico/helico/apps/be/internal/session"
)

// Options tune the handler; zero values are safe.
type Options struct {
	AdminToken     string
	CORSOrigins    []string
	Logger         *slog.Logger
	RequestTimeout time.Duration
	// Chats is optional. Without it the conversation routes answer 503 rather than vanishing,
	// so a caller is told the feature is off instead of guessing at a 404.
	Chats *chat.Service
	// SessionSecret signs the session cookie. Empty means a fresh random one, and every
	// restart signs everyone out.
	SessionSecret string
	// SessionLife defaults to seven days, NonceTTL to two minutes.
	SessionLife time.Duration
	NonceTTL    time.Duration
	// Now is the clock, for tests.
	Now func() time.Time
}

// cacheControl is what a CDN or browser may do with a read: keep it for a minute, serve it
// stale for five more while revalidating with the ETag.
const cacheControl = "public, max-age=60, stale-while-revalidate=300"

// maxBodyBytes bounds a PUT body; posts are capped at 256 KiB of Markdown plus metadata.
const maxBodyBytes = 1 << 20

// New builds the handler with its middleware.
func New(svc *blog.Service, opt Options) http.Handler {
	if opt.Logger == nil {
		opt.Logger = slog.Default()
	}
	if opt.Now == nil {
		opt.Now = time.Now
	}
	cookies, err := session.NewCookies(opt.SessionSecret, opt.SessionLife)
	if err != nil {
		// crypto/rand failing is not a condition a server can serve through.
		panic(err)
	}
	api := &api{
		svc:     svc,
		opt:     opt,
		chats:   opt.Chats,
		nonces:  session.NewNonces(opt.NonceTTL),
		cookies: cookies,
		now:     opt.Now,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", api.health)
	mux.HandleFunc("GET /api/posts", api.list)
	mux.HandleFunc("GET /api/posts/{slug}", api.get)
	mux.HandleFunc("PUT /api/posts/{slug}", api.requireAdmin(api.put))
	mux.HandleFunc("DELETE /api/posts/{slug}", api.requireAdmin(api.delete))

	// The wallet is the identity: prove it once, carry a cookie after that.
	mux.HandleFunc("GET /api/session/nonce", api.nonce)
	mux.HandleFunc("POST /api/session", api.signIn)
	mux.HandleFunc("GET /api/session", api.whoami)
	mux.HandleFunc("DELETE /api/session", api.signOut)

	// Every one of these reads the owner from the cookie and from nowhere else.
	mux.HandleFunc("GET /api/chats", api.requireSession(api.listChats))
	mux.HandleFunc("POST /api/chats", api.requireSession(api.startChat))
	mux.HandleFunc("DELETE /api/chats", api.requireSession(api.deleteChats))
	mux.HandleFunc("GET /api/chats/{id}", api.requireSession(api.getChat))
	mux.HandleFunc("POST /api/chats/{id}/messages", api.requireSession(api.appendMessage))
	mux.HandleFunc("DELETE /api/chats/{id}", api.requireSession(api.deleteChat))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { writeProblem(w, http.StatusNotFound, "") })

	var h http.Handler = mux
	h = gzipper(h)
	h = cors(opt.CORSOrigins)(h)
	if opt.RequestTimeout > 0 {
		h = http.TimeoutHandler(h, opt.RequestTimeout, `{"type":"about:blank","title":"Service Unavailable","status":503,"detail":"request timed out"}`)
	}
	h = logging(opt.Logger)(h)
	h = requestID(h)
	h = recoverer(opt.Logger)(h)
	return h
}

type api struct {
	svc     *blog.Service
	opt     Options
	chats   *chat.Service
	nonces  *session.Nonces
	cookies *session.Cookies
	now     func() time.Time
}

// postView is the JSON shape of a post. Full includes the body; list items omit it.
type postView struct {
	Slug           string    `json:"slug"`
	Title          string    `json:"title"`
	Summary        string    `json:"summary"`
	Author         string    `json:"author"`
	Cover          string    `json:"cover,omitempty"`
	Tags           []string  `json:"tags"`
	ReadingMinutes int       `json:"reading_minutes"`
	PublishedAt    time.Time `json:"published_at"`
	UpdatedAt      time.Time `json:"updated_at"`
	HTML           string    `json:"html,omitempty"`
	Markdown       string    `json:"markdown,omitempty"`
}

func view(p blog.Post, full bool) postView {
	v := postView{Slug: p.Slug, Title: p.Title, Summary: p.Summary, Author: p.Author, Cover: p.Cover, Tags: p.Tags,
		ReadingMinutes: p.ReadingMinutes, PublishedAt: p.PublishedAt, UpdatedAt: p.UpdatedAt}
	if full {
		v.HTML, v.Markdown = p.HTML, p.Markdown
	}
	return v
}

type listView struct {
	Items      []postView `json:"items"`
	NextCursor *string    `json:"next_cursor"`
}

// draftBody is what a PUT carries.
type draftBody struct {
	Title       string     `json:"title"`
	Summary     string     `json:"summary"`
	Author      string     `json:"author"`
	Cover       string     `json:"cover"`
	Tags        []string   `json:"tags"`
	Markdown    string     `json:"markdown"`
	PublishedAt *time.Time `json:"published_at"`
}

func (a *api) health(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (a *api) list(w http.ResponseWriter, r *http.Request) {
	limit := 0
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 {
			writeProblem(w, http.StatusBadRequest, "limit: a positive integer")
			return
		}
		limit = n
	}
	page, err := a.svc.List(r.Context(), limit, r.URL.Query().Get("cursor"))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if notModified(w, r, page.ETag()) {
		return
	}
	items := make([]postView, len(page.Items))
	for i, p := range page.Items {
		items[i] = view(p, false)
	}
	out := listView{Items: items}
	if page.NextCursor != "" {
		out.NextCursor = &page.NextCursor
	}
	w.Header().Set("Cache-Control", cacheControl)
	writeJSON(w, http.StatusOK, out)
}

func (a *api) get(w http.ResponseWriter, r *http.Request) {
	p, err := a.svc.Get(r.Context(), r.PathValue("slug"))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if notModified(w, r, p.ETag()) {
		return
	}
	w.Header().Set("Cache-Control", cacheControl)
	writeJSON(w, http.StatusOK, view(p, true))
}

func (a *api) put(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var body draftBody
	if err := dec.Decode(&body); err != nil {
		writeProblem(w, http.StatusBadRequest, "body: "+err.Error())
		return
	}
	slug := r.PathValue("slug")
	p, created, err := a.svc.Save(r.Context(), slug, blog.Draft{Title: body.Title, Summary: body.Summary, Author: body.Author,
		Cover: body.Cover, Tags: body.Tags, Markdown: body.Markdown, PublishedAt: body.PublishedAt})
	if err != nil {
		a.fail(w, r, err)
		return
	}
	w.Header().Set("ETag", p.ETag())
	w.Header().Set("Cache-Control", "no-store")
	status := http.StatusOK
	if created {
		status = http.StatusCreated
		w.Header().Set("Location", "/api/posts/"+slug)
	}
	writeJSON(w, status, view(p, true))
}

func (a *api) delete(w http.ResponseWriter, r *http.Request) {
	if err := a.svc.Delete(r.Context(), r.PathValue("slug")); err != nil {
		a.fail(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

// requireAdmin gates writes behind the bearer token, and refuses them outright when none is
// configured, so a deployment cannot be written to by accident.
func (a *api) requireAdmin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if a.opt.AdminToken == "" {
			writeProblem(w, http.StatusServiceUnavailable, "writes are disabled: BE_ADMIN_TOKEN is not set")
			return
		}
		token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok || subtle.ConstantTimeCompare([]byte(token), []byte(a.opt.AdminToken)) != 1 {
			w.Header().Set("WWW-Authenticate", `Bearer realm="helico"`)
			writeProblem(w, http.StatusUnauthorized, "a valid bearer token is required")
			return
		}
		next(w, r)
	}
}

// notModified sets the ETag and answers 304 when the client already has this version.
func notModified(w http.ResponseWriter, r *http.Request, etag string) bool {
	w.Header().Set("ETag", etag)
	for _, candidate := range strings.Split(r.Header.Get("If-None-Match"), ",") {
		if strings.TrimSpace(candidate) == etag {
			w.Header().Set("Cache-Control", cacheControl)
			w.WriteHeader(http.StatusNotModified)
			return true
		}
	}
	return false
}

// fail maps domain errors to statuses; anything else is a 500 with a log line.
func (a *api) fail(w http.ResponseWriter, r *http.Request, err error) {
	var verr *blog.ValidationError
	switch {
	case errors.Is(err, blog.ErrNotFound):
		writeProblem(w, http.StatusNotFound, "no post with that slug")
	case errors.As(err, &verr):
		writeProblem(w, http.StatusUnprocessableEntity, verr.Error())
	default:
		a.opt.Logger.Error("request failed", "err", err, "path", r.URL.Path, "request_id", requestIDFrom(r))
		writeProblem(w, http.StatusInternalServerError, "")
	}
}
