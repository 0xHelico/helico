// Package config reads the backend's settings from the environment. There is no file: a
// deployment sets variables, and every value has a default that works for a local run.
package config

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/0xHelico/helico/apps/be/internal/swap"
)

// Config is everything the process needs to know before it serves a request.
type Config struct {
	// Addr is the listen address, host optional.
	Addr string
	// DBPath is the SQLite file. Its directory is created if missing.
	DBPath string
	// AdminToken guards writes. Empty means writes are refused with 503.
	AdminToken string
	// CORSOrigins are the browser origins allowed to call the API.
	CORSOrigins []string
	// ContentDir holds the Markdown posts seeded on boot. Empty or missing means no seeding.
	ContentDir string
	// RequestTimeout bounds one request end to end.
	RequestTimeout time.Duration
	// ShutdownTimeout bounds the drain on SIGTERM.
	ShutdownTimeout time.Duration
	// SessionSecret signs the session cookie. Empty means a random one at boot, which signs
	// everyone out on every restart — the process says so rather than leaving it a mystery.
	SessionSecret string
	// LLMs are the OpenAI-compatible endpoints the swap conversation may ask, in order. An entry
	// with no key is dropped, so one set of variables is a single model and two is a fallback.
	// Empty means the route answers 503.
	LLMs []swap.Upstream
	// LLMTimeout bounds one call to one model, not the chain.
	LLMTimeout time.Duration
	// SwapBudget is what POST /api/swap/intent gets, which is more than every other route: the
	// whole chain of models has to fit, and a status question adds the index's own calls on top.
	// Derived rather than configured, so no combination of the two is unreachable.
	SwapBudget time.Duration
	// SwapRatePerMin is how many swap messages one address may send in a minute.
	SwapRatePerMin int
	// SwapDailyMax is the whole process's ceiling on model calls per day, because each one
	// costs money.
	SwapDailyMax int
	// SubgraphURL is the subgraph the cache stands in front of. The default is the same Studio
	// deployment packages/plugins/thegraph names; that package is the source of truth for it,
	// and this is a copy so a deployment can be pointed elsewhere without a rebuild.
	SubgraphURL string
	// GraphTTL is how long an answer is served before it is asked for again. Aqua movements are
	// minutes-old news, so a minute of staleness costs nothing and takes the repeated load off a
	// Studio endpoint that is rate-limited per month.
	GraphTTL time.Duration
	// GraphRatePerMin is how many subgraph reads one address may make in a minute.
	GraphRatePerMin int
	// GraphMCPURL is The Graph's Subgraph MCP server. Empty — the default — means the chat does
	// not read the index and the status answer is exactly what it was before 12 September.
	GraphMCPURL string
	// GraphMCPSubgraphID is the id of Helico's subgraph on The Graph Network (not the Studio
	// deployment: the MCP serves the network only). Empty means off, like the URL.
	GraphMCPSubgraphID string
	// GraphMCPKey is sent as a Bearer token when set. The server answers without one.
	GraphMCPKey string
	// GraphMCPTimeout bounds one whole question: every model and MCP call together.
	GraphMCPTimeout time.Duration
	// TelegramToken is the bot's credential. Empty means no bot and no webhook at all.
	TelegramToken string
	// TelegramSecret is the value Telegram echoes in X-Telegram-Bot-Api-Secret-Token. A token with
	// no secret refuses every caller rather than accepting every caller.
	TelegramSecret string
	// TelegramRatePerMin is what one Telegram user may ask for in a minute.
	TelegramRatePerMin int
	// RPCURL is the chain this reads an account's own logs from. The default is Arbitrum One's
	// public endpoint: it carries no key, a judge can curl it, and it is the same URL the dapp
	// used to scan from every browser — which is the cost this endpoint exists to stop paying.
	RPCURL string
	// ActivityFrom is the first block worth scanning: `HelicoAccountFactory`'s own deployment.
	// Nothing can predate the contract that creates these accounts, so it is exact rather than a
	// safe underestimate, and it skips the 485 million blocks before it.
	ActivityFrom uint64
	// ActivityFresh is how long a watermark is trusted before the head is asked for again. The
	// enclave acts every five minutes at most, so a quarter of that is generous.
	ActivityFresh time.Duration
}

// Lookup is the shape of os.LookupEnv, so tests can feed a map.
type Lookup func(key string) (string, bool)

// FromEnv builds a Config from BE_* variables, filling defaults for the rest.
// devOrigins is what a local run needs: the dapp on Next's dev port and on the port its browser
// checks serve a production build from, and the landing site on Astro's two.
//
// The dapp's :3000 was missing for as long as this list existed, so a local page could not even
// read the session endpoint — the browser refused the response before the cookie was ever the
// question. :3100 is here so `bun run e2e` reaches a local backend without being told to.
// defaultSubgraph is Helico's Aqua deployment on Studio. It carries no key — a judge can curl it
// — so it is a default rather than a secret.
const defaultSubgraph = "https://api.studio.thegraph.com/query/1758877/helico-arbitrum-one/version/latest"

// defaultRPC is Arbitrum One's public endpoint, and defaultActivityFrom is the factory's own
// deployment block — the same two constants the dapp carried when it did this scan itself.
const defaultRPC = "https://arb1.arbitrum.io/rpc"

const defaultActivityFrom = 502_979_401

const devOrigins = "http://localhost:3000,http://localhost:3100,http://localhost:4321,http://localhost:4322"

func FromEnv(lookup Lookup) (Config, error) {
	get := func(key, def string) string {
		if v, ok := lookup(key); ok && strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
		return def
	}
	cfg := Config{
		Addr:            get("BE_ADDR", ":8787"),
		DBPath:          get("BE_DB_PATH", "data/helico.db"),
		AdminToken:      get("BE_ADMIN_TOKEN", ""),
		ContentDir:      get("BE_CONTENT_DIR", "content"),
		RequestTimeout:  10 * time.Second,
		ShutdownTimeout: 10 * time.Second,
		SessionSecret:   get("BE_SESSION_SECRET", ""),
		LLMs: []swap.Upstream{
			{
				BaseURL: get("BE_LLM_BASE_URL", "https://api.openai.com/v1"),
				Key:     get("BE_LLM_API_KEY", ""),
				Model:   get("BE_LLM_MODEL", "gpt-4o-mini"),
				User:    get("BE_LLM_USER", ""),
				Pass:    get("BE_LLM_PASS", ""),
			},
			{
				BaseURL: get("BE_LLM_FALLBACK_BASE_URL", ""),
				Key:     get("BE_LLM_FALLBACK_API_KEY", ""),
				Model:   get("BE_LLM_FALLBACK_MODEL", ""),
				User:    get("BE_LLM_FALLBACK_USER", ""),
				Pass:    get("BE_LLM_FALLBACK_PASS", ""),
			},
		},
		// Thirty seconds because it was measured, not guessed. Asked the real system prompt on
		// 12 September, one router answered in 1.3 and 2.2 seconds; the other, a reasoning agent
		// behind a router that prepends its own prompt, took 6.7, 6.8, 25.7 and 19.5. Twelve
		// seconds fitted the first and timed the second out about half the time, which would have
		// made it a menu entry that mostly does not work.
		LLMTimeout:         30 * time.Second,
		SwapRatePerMin:     6,
		SwapDailyMax:       500,
		SubgraphURL:        get("BE_SUBGRAPH_URL", defaultSubgraph),
		GraphTTL:           60 * time.Second,
		GraphRatePerMin:    120,
		GraphMCPURL:        get("BE_GRAPH_MCP_URL", ""),
		GraphMCPSubgraphID: get("BE_GRAPH_MCP_SUBGRAPH_ID", ""),
		GraphMCPKey:        get("BE_GRAPH_MCP_API_KEY", ""),
		GraphMCPTimeout:    40 * time.Second,
		TelegramToken:      get("BE_TELEGRAM_TOKEN", ""),
		TelegramSecret:     get("BE_TELEGRAM_SECRET", ""),
		TelegramRatePerMin: 12,
		RPCURL:             get("BE_RPC_URL", defaultRPC),
		ActivityFrom:       defaultActivityFrom,
		ActivityFresh:      75 * time.Second,
	}
	for _, o := range strings.Split(get("BE_CORS_ORIGINS", devOrigins), ",") {
		if o = strings.TrimSpace(o); o != "" {
			cfg.CORSOrigins = append(cfg.CORSOrigins, o)
		}
	}
	for _, d := range []struct {
		key string
		dst *time.Duration
		set *bool
	}{{"BE_REQUEST_TIMEOUT", &cfg.RequestTimeout, nil}, {"BE_LLM_TIMEOUT", &cfg.LLMTimeout, nil}, {"BE_GRAPH_TTL", &cfg.GraphTTL, nil}, {"BE_GRAPH_MCP_TIMEOUT", &cfg.GraphMCPTimeout, nil}} {
		if v, ok := lookup(d.key); ok && strings.TrimSpace(v) != "" {
			parsed, err := time.ParseDuration(strings.TrimSpace(v))
			if err != nil {
				return Config{}, fmt.Errorf("%s: %w", d.key, err)
			}
			*d.dst = parsed
			if d.set != nil {
				*d.set = true
			}
		}
	}
	for _, n := range []struct {
		key string
		dst *int
	}{{"BE_SWAP_RATE_PER_MIN", &cfg.SwapRatePerMin}, {"BE_TELEGRAM_RATE_PER_MIN", &cfg.TelegramRatePerMin}, {"BE_SWAP_DAILY_MAX", &cfg.SwapDailyMax}, {"BE_GRAPH_RATE_PER_MIN", &cfg.GraphRatePerMin}} {
		if v, ok := lookup(n.key); ok && strings.TrimSpace(v) != "" {
			parsed, err := strconv.Atoi(strings.TrimSpace(v))
			if err != nil || parsed < 0 {
				return Config{}, fmt.Errorf("%s: want a whole number, got %q", n.key, v)
			}
			*n.dst = parsed
		}
	}
	// **The swap route's budget is derived, not validated.** It used to be a check: a model given
	// longer than the request that wraps it can never finish, so an operator who wrote that
	// combination was refused at startup and one who only shortened the request timeout had the
	// model timeout quietly fitted under it.
	//
	// That check exists because the two numbers were in tension. They are not any more. The chain
	// of models is one whole call per model, a status question adds the index's calls after them,
	// and both of those are properties of one route rather than of every request — so that route
	// gets what it needs and everything else keeps the general budget. Nothing is unreachable, so
	// there is nothing left to refuse.
	attempts := time.Duration(0)
	for _, u := range cfg.LLMs {
		if u.Key != "" {
			attempts++
		}
	}
	if attempts < 1 {
		attempts = 1
	}
	cfg.SwapBudget = cfg.LLMTimeout * attempts
	// A status question asks a model several times over and reads the index between the asks, so
	// that budget is the larger of the two rather than the sum: they are alternative shapes of the
	// same request, not stages of it.
	if cfg.GraphMCPURL != "" && cfg.GraphMCPTimeout > cfg.SwapBudget {
		cfg.SwapBudget = cfg.GraphMCPTimeout
	}
	if cfg.RequestTimeout > cfg.SwapBudget {
		cfg.SwapBudget = cfg.RequestTimeout
	}
	// Two seconds for the handler to write the answer it already has.
	cfg.SwapBudget += 2 * time.Second
	return cfg, nil
}
