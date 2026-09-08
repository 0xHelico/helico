// Command be serves Helico's AI side and its blog: posts in SQLite, seeded from Markdown
// files, and a swap conversation that turns a sentence into a checked intent. Configuration is
// BE_* environment variables; see internal/config.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/0xHelico/helico/apps/be/internal/blog"
	"github.com/0xHelico/helico/apps/be/internal/chat"
	"github.com/0xHelico/helico/apps/be/internal/config"
	"github.com/0xHelico/helico/apps/be/internal/content"
	"github.com/0xHelico/helico/apps/be/internal/graph"
	"github.com/0xHelico/helico/apps/be/internal/httpapi"
	"github.com/0xHelico/helico/apps/be/internal/store"
	"github.com/0xHelico/helico/apps/be/internal/swap"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "be:", err)
		os.Exit(1)
	}
}

func run() error {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	cfg, err := config.FromEnv(os.LookupEnv)
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	db, err := store.Open(ctx, cfg.DBPath)
	if err != nil {
		return err
	}
	defer db.Close()

	swapSvc := swap.New(swap.NewClient(cfg.LLMBaseURL, cfg.LLMKey, cfg.LLMModel, cfg.LLMTimeout))

	// Only the two the app sends. The list is here rather than in the cache so that adding a
	// query to the frontend is a visible change to what this process will forward.
	subgraph := graph.New(cfg.SubgraphURL, cfg.GraphTTL, []string{"Mandates", "Movements"}, 10*time.Second)

	svc := blog.NewService(db)
	chats := chat.NewService(db)
	if cfg.SessionSecret == "" {
		key, path, err := rememberedSecret(cfg.DBPath)
		if err != nil {
			log.Warn("BE_SESSION_SECRET is unset and no key could be kept; every restart will sign everyone out", "err", err)
		} else {
			log.Warn("BE_SESSION_SECRET is unset; using the key kept beside the database", "path", path)
			cfg.SessionSecret = key
		}
	}
	if n, err := content.Seed(ctx, cfg.ContentDir, svc); err != nil {
		return fmt.Errorf("seed: %w", err)
	} else if n > 0 {
		log.Info("seeded posts", "written", n, "dir", cfg.ContentDir)
	}

	srv := &http.Server{
		Addr: cfg.Addr,
		Handler: httpapi.New(svc, httpapi.Options{
			AdminToken:      cfg.AdminToken,
			CORSOrigins:     cfg.CORSOrigins,
			Logger:          log,
			RequestTimeout:  cfg.RequestTimeout,
			Chats:           chats,
			SessionSecret:   cfg.SessionSecret,
			Swap:            swapSvc,
			SwapRatePerMin:  cfg.SwapRatePerMin,
			SwapDailyMax:    cfg.SwapDailyMax,
			Graph:           subgraph,
			GraphRatePerMin: cfg.GraphRatePerMin,
		}),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      cfg.RequestTimeout + 5*time.Second,
		IdleTimeout:       60 * time.Second,
	}

	errc := make(chan error, 1)
	go func() {
		log.Info("listening", "addr", cfg.Addr, "db", cfg.DBPath, "writes", cfg.AdminToken != "", "swap", swapSvc.Configured())
		errc <- srv.ListenAndServe()
	}()

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	shutdown, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(shutdown); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("shutdown: %w", err)
	}
	log.Info("stopped")
	return nil
}

// rememberedSecret keeps a local run signed in across restarts.
//
// An unset BE_SESSION_SECRET means a key generated at boot, so every `go run` invalidated every
// cookie — which reads as "the session does not work" rather than "the key changed", and cost a
// day of looking at the wrong end of it. This writes one beside the database, readable only by
// its owner, and reuses it.
//
// It is not a fallback for a deployment. Every environment we run sets the variable, and one that
// forgets to still gets the warning above — it just gets a working session while it is forgotten,
// instead of an unusable one.
func rememberedSecret(dbPath string) (string, string, error) {
	dir := filepath.Dir(dbPath)
	path := filepath.Join(dir, ".session-key")
	if b, err := os.ReadFile(path); err == nil {
		if key := strings.TrimSpace(string(b)); len(key) >= 32 {
			return key, path, nil
		}
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", path, err
	}
	key := hex.EncodeToString(raw)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", path, err
	}
	// 0600: it signs every session this process issues.
	if err := os.WriteFile(path, []byte(key), 0o600); err != nil {
		return "", path, err
	}
	return key, path, nil
}
