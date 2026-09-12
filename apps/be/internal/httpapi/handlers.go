// Package httpapi exposes the API over HTTP: the blog's five routes and the swap
// conversation, JSON in and out, problem+json for errors, ETags for caches. What a post is
// lives in the blog package, and what a swap request means lives in the swap package.
package httpapi

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/0xHelico/helico/apps/be/internal/activity"
	"github.com/0xHelico/helico/apps/be/internal/blog"
	"github.com/0xHelico/helico/apps/be/internal/chat"
	"github.com/0xHelico/helico/apps/be/internal/graph"
	"github.com/0xHelico/helico/apps/be/internal/session"
	"github.com/0xHelico/helico/apps/be/internal/swap"
)

// Options tune the handler; zero values are safe.
type Options struct {
	AdminToken     string
	CORSOrigins    []string
	Logger         *slog.Logger
	RequestTimeout time.Duration
	// SwapTimeout is the budget for POST /api/swap/intent alone, which needs more than the rest:
	// a status question makes several model and MCP calls in a row, and asking a slow model with a
	// fallback behind it is two whole model calls. Zero, or less than RequestTimeout, and that
	// route keeps the general budget. `config.SwapBudget` is where the figure comes from.
	SwapTimeout time.Duration
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
	// Swap answers the swap conversation. Nil, or unconfigured, means that route says so.
	Swap *swap.Service
	// Index is the subgraph the chat may read through The Graph's Subgraph MCP, for a status
	// question. Nil or unconfigured means the status answer is what it always was.
	Index *swap.Index
	// SwapRatePerMin and SwapDailyMax bound what the paid model costs.
	SwapRatePerMin int
	SwapDailyMax   int
	// Graph caches subgraph reads. Nil means the route is not served and the browser goes
	// straight to Studio, which is what it did before this existed.
	Graph *graph.Cache
	// GraphRatePerMin bounds what one address may spend of the shared subgraph quota.
	GraphRatePerMin int
	// Activity owns one account's history, read from its own logs and kept. Nil means the route
	// says so rather than answering an empty list, because "nothing happened" and "we cannot
	// look" are different answers and only one of them is about the account.
	Activity *activity.Service
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
		svc:        svc,
		opt:        opt,
		chats:      opt.Chats,
		nonces:     session.NewNonces(opt.NonceTTL),
		cookies:    cookies,
		now:        opt.Now,
		limit:      newLimiter(opt.SwapRatePerMin, opt.SwapDailyMax),
		graph:      opt.Graph,
		graphLimit: newLimiter(opt.GraphRatePerMin, 0),
		activity:   opt.Activity,
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

	mux.HandleFunc("POST /api/swap/intent", api.swapIntent)
	// What the composer shows before anyone types: which model answers, and whether it can.
	// The app asking rather than being told is what stops the two drifting apart — and an
	// unconfigured key becomes something the page can say, rather than a 503 on send.
	mux.HandleFunc("GET /api/swap/config", api.swapConfig)

	// The subgraph, cached. A GraphQL endpoint like the one it stands in front of, so the client
	// that speaks to Studio speaks to this by changing a URL and nothing else.
	mux.HandleFunc("POST /api/graph", api.graphQuery)

	// One account's own history, from the database. Shares the graph budget rather than the swap
	// one: both are reads a page makes on load, and neither should be able to spend the allowance
	// of the endpoint that costs money.
	mux.HandleFunc("GET /api/activity", api.accountActivity)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { writeProblem(w, http.StatusNotFound, "") })

	var h http.Handler = mux
	h = gzipper(h)
	h = cors(opt.CORSOrigins)(h)
	if opt.RequestTimeout > 0 {
		const timedOut = `{"type":"about:blank","title":"Service Unavailable","status":503,"detail":"request timed out"}`
		timed := http.TimeoutHandler(h, opt.RequestTimeout, timedOut)
		// **One route needs more room than the rest, and it is the only one that gets it.** A
		// status question makes several model and MCP calls in a row, and a chain of models is one
		// whole call per model — measured, the slower of the two answers in anything from 6 to 26
		// seconds. A budget sized for a single fast model cannot hold either, and the failure is a
		// 503 that reads exactly like an unset key.
		//
		// Every other route keeps the general budget, so nothing else holds a connection open for
		// as long as this one may.
		if opt.SwapTimeout > opt.RequestTimeout {
			longer := http.TimeoutHandler(h, opt.SwapTimeout, timedOut)
			h = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodPost && r.URL.Path == "/api/swap/intent" {
					longer.ServeHTTP(w, r)
					return
				}
				timed.ServeHTTP(w, r)
			})
		} else {
			h = timed
		}
	}
	h = logging(opt.Logger)(h)
	h = secureHeaders(h)
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
	limit   *limiter
	graph   *graph.Cache
	// Owns an account's history rather than caching a question about it. Nil when this build has
	// no chain endpoint, and the handler says so instead of answering with nothing.
	activity *activity.Service
	// A budget of its own. Sharing the swap limiter would let a page that reads mandates spend
	// the allowance for the endpoint that costs money.
	graphLimit *limiter
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

// readTheIndex adds one step per index read, so the tree under the answer shows that the subgraph
// was asked and what was asked of it, and then one more step with what the model concluded from
// the results. A failure adds a failed step and changes nothing else — the reply the person would
// have had without the index is the reply they get.
//
// **The sentence is a step, not a card.** It was a card once, and #455 removed it for good
// reason: the version it looked at read "you have a Helico account with the address 0x0acd…, it
// was opened on September 10, 2026, at 17:58:38 UTC, the transaction that opened the account has
// the hash 0x0673…" — three lines of address, hash and timestamp, debug output wearing an
// answer's clothes, above steps that already carried the calls. But removing the sentence left
// the loop paying for up to five model-written queries and discarding the result, which is a
// state that cannot be defended either way (#464). So it is back where #455 said the evidence
// belongs — under the `mcp.*` calls, last — capped in code to two sentences with no hash and no
// full address, so the tree reads: what was asked, what came back, what was concluded.
func (a *api) readTheIndex(ctx context.Context, answer *swap.Answer, question, address string) {
	owner := strings.ToLower(strings.TrimSpace(address))
	if !isAddress(owner) {
		owner = ""
	}
	got, steps, err := a.opt.Swap.Ask(ctx, a.opt.Index, question, owner)
	answer.Steps = append(answer.Steps, steps...)
	if err != nil {
		a.opt.Logger.Warn("the index did not answer", "error", err)
		return
	}
	// The model's reading, as the last step under the calls that produced it — what was asked,
	// what came back, what was concluded, in the order a reader checks them (#464). Capped here
	// to two sentences with no hash and no full address, because the prompt asking for that is a
	// request and this line is what a person reads.
	if sentence := swap.Sentence(got.Answer); sentence != "" {
		answer.Steps = append(answer.Steps, swap.Step{Call: "index.answer", Detail: sentence, OK: true})
	}
}

func isAddress(s string) bool {
	if len(s) != 42 || !strings.HasPrefix(s, "0x") {
		return false
	}
	for _, c := range s[2:] {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
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

// swapIntent turns a sentence into a checked swap intent. It reads nothing and writes nothing:
// the whole endpoint is an interpreter, and the caller signs whatever they decide to sign.
func (a *api) swapIntent(w http.ResponseWriter, r *http.Request) {
	if a.opt.Swap == nil || !a.opt.Swap.Configured() {
		writeProblem(w, http.StatusServiceUnavailable, "the swap conversation is off: BE_LLM_API_KEY is not set")
		return
	}
	if ok, reason := a.limit.allow(clientAddr(r)); !ok {
		w.Header().Set("Retry-After", "60")
		writeProblem(w, http.StatusTooManyRequests, reason)
		return
	}

	var body struct {
		Message string `json:"message"`
		// What was already on screen. Optional, bounded by the service, and only ever a hint to
		// the model: every token and amount still goes through the registry afterwards.
		History []swap.Turn `json:"history"`
		// The connected wallet, optional. Used for one thing: telling the index whose account a
		// status question is about. Nothing here trusts it — it is a filter on public data.
		Address string `json:"address"`
		// Which configured model to ask first, by the family name GET /api/swap/config published.
		//
		// **It selects, it does not describe.** The value is matched against the models this
		// process already holds; it is never an address, a key or a routing string, so a caller
		// cannot point the service at an endpoint nobody configured. A name that matches nothing
		// leaves the order alone, because the list a page is holding can be a deploy out of date
		// and an answer from the model that does exist beats an error about a menu.
		Model string `json:"model"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 16<<10)).Decode(&body); err != nil {
		writeProblem(w, http.StatusBadRequest, "send {\"message\": \"…\"}")
		return
	}

	answer, err := a.opt.Swap.Prefer(body.Model).Interpret(r.Context(), body.Message, body.History...)
	if err == nil && answer.Action == swap.ActionStatus && a.opt.Index.Configured() {
		a.readTheIndex(r.Context(), &answer, body.Message, body.Address)
	}
	switch {
	case errors.Is(err, swap.ErrNotConfigured):
		writeProblem(w, http.StatusServiceUnavailable, "the swap conversation is off: BE_LLM_API_KEY is not set")
	case err != nil && r.Context().Err() != nil:
		writeProblem(w, http.StatusGatewayTimeout, "the model took too long")
	case err != nil:
		// The model failing is this service's problem to own. The error can carry the provider's
		// own message and, when the call never connected, BE_LLM_BASE_URL inside a *url.Error, so
		// it goes to the log and the caller gets a sentence that says nothing about our setup.
		a.opt.Logger.Warn("swap intent failed", "error", err)
		writeProblem(w, http.StatusBadGateway, "the model could not be reached; try again in a moment")
	default:
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, http.StatusOK, answer)
	}
}
