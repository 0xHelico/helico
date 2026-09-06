// Package config reads the backend's settings from the environment. There is no file: a
// deployment sets variables, and every value has a default that works for a local run.
package config

import (
	"fmt"
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
	// SessionSecret signs the session cookie. Empty means a random one at boot, which signs
	// everyone out on every restart — the process says so rather than leaving it a mystery.
	SessionSecret string
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
		SessionSecret:   get("BE_SESSION_SECRET", ""),
	}
	for _, o := range strings.Split(get("BE_CORS_ORIGINS", "http://localhost:4321,http://localhost:4322"), ",") {
		if o = strings.TrimSpace(o); o != "" {
			cfg.CORSOrigins = append(cfg.CORSOrigins, o)
		}
	}
	if v, ok := lookup("BE_REQUEST_TIMEOUT"); ok && v != "" {
		d, err := time.ParseDuration(v)
		if err != nil {
			return Config{}, fmt.Errorf("BE_REQUEST_TIMEOUT: %w", err)
		}
		cfg.RequestTimeout = d
	}
	return cfg, nil
}
