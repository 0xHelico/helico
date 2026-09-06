// Package config reads the backend's settings from the environment. There is no file: a
// deployment sets variables, and every value has a default that works for a local run.
package config

import (
	"fmt"
	"strconv"
	"strings"
	"time"
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
	// LLMBaseURL is any OpenAI-compatible endpoint.
	LLMBaseURL string
	// LLMKey enables the swap conversation. Empty means the route answers 503.
	LLMKey string
	// LLMModel is the model asked for the swap JSON.
	LLMModel string
	// LLMTimeout bounds one call to the model.
	LLMTimeout time.Duration
	// SwapRatePerMin is how many swap messages one address may send in a minute.
	SwapRatePerMin int
	// SwapDailyMax is the whole process's ceiling on model calls per day, because each one
	// costs money.
	SwapDailyMax int
}

// Lookup is the shape of os.LookupEnv, so tests can feed a map.
type Lookup func(key string) (string, bool)

// FromEnv builds a Config from BE_* variables, filling defaults for the rest.
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
		LLMBaseURL:      get("BE_LLM_BASE_URL", "https://api.openai.com/v1"),
		LLMKey:          get("BE_LLM_API_KEY", ""),
		LLMModel:        get("BE_LLM_MODEL", "gpt-4o-mini"),
		LLMTimeout:      20 * time.Second,
		SwapRatePerMin:  6,
		SwapDailyMax:    500,
	}
	for _, o := range strings.Split(get("BE_CORS_ORIGINS", "http://localhost:4321,http://localhost:4322"), ",") {
		if o = strings.TrimSpace(o); o != "" {
			cfg.CORSOrigins = append(cfg.CORSOrigins, o)
		}
	}
	for _, d := range []struct {
		key string
		dst *time.Duration
	}{{"BE_REQUEST_TIMEOUT", &cfg.RequestTimeout}, {"BE_LLM_TIMEOUT", &cfg.LLMTimeout}} {
		if v, ok := lookup(d.key); ok && strings.TrimSpace(v) != "" {
			parsed, err := time.ParseDuration(strings.TrimSpace(v))
			if err != nil {
				return Config{}, fmt.Errorf("%s: %w", d.key, err)
			}
			*d.dst = parsed
		}
	}
	for _, n := range []struct {
		key string
		dst *int
	}{{"BE_SWAP_RATE_PER_MIN", &cfg.SwapRatePerMin}, {"BE_SWAP_DAILY_MAX", &cfg.SwapDailyMax}} {
		if v, ok := lookup(n.key); ok && strings.TrimSpace(v) != "" {
			parsed, err := strconv.Atoi(strings.TrimSpace(v))
			if err != nil || parsed < 0 {
				return Config{}, fmt.Errorf("%s: want a whole number, got %q", n.key, v)
			}
			*n.dst = parsed
		}
	}
	return cfg, nil
}
