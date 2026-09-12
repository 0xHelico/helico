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

	"github.com/0xHelico/helico/apps/be/internal/activity"
	"github.com/0xHelico/helico/apps/be/internal/blog"
	"github.com/0xHelico/helico/apps/be/internal/chat"
	"github.com/0xHelico/helico/apps/be/internal/config"
	"github.com/0xHelico/helico/apps/be/internal/content"
	"github.com/0xHelico/helico/apps/be/internal/graph"
	"github.com/0xHelico/helico/apps/be/internal/graphmcp"
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
	// A local run reads `.env` beside the binary for what the environment does not set; a
	// deployment sets variables and never has the file. The environment wins either way.
	cfg, err := config.FromEnv(config.DotEnv(".env", os.LookupEnv))
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

	// The models, in the order they are asked. One set of variables is a single model; two is a
	// fallback, and an entry with no key is dropped rather than being tried and failing.
	swapSvc := swap.New(swap.NewClient(cfg.LLMTimeout, cfg.LLMs...))

	// The index the chat may read for a status question, through The Graph's Subgraph MCP. Off
	// unless both the server and the subgraph's network id are set, and then the intent route
	// gets a budget that fits several calls in a row.
	index := &swap.Index{
		MCP:          graphmcp.New(cfg.GraphMCPURL, cfg.GraphMCPKey, 15*time.Second),
		SubgraphID:   cfg.GraphMCPSubgraphID,
		MaxQueries:   5,
		Timeout:      cfg.GraphMCPTimeout,
		ModelTimeout: 25 * time.Second,
	}
	// The swap route may hold a connection for the whole chain of models, so the server's own
	// write deadline is sized from the longest route rather than from the general one.
	writeTimeout := cfg.SwapBudget + 5*time.Second
	if index.Configured() && index.Timeout+7*time.Second > writeTimeout {
		writeTimeout = index.Timeout + 7*time.Second
	}

	// Only the two the app sends. The list is here rather than in the cache so that adding a
	// query to the frontend is a visible change to what this process will forward.
	subgraph := graph.New(cfg.SubgraphURL, cfg.GraphTTL, []string{"Mandates", "Movements"}, 10*time.Second)

	// An account's own history, owned rather than cached: the log is append-only, so the watermark
	// in the database means the second read costs one narrow query instead of a scan from the
	// factory's deployment block. The dapp was paying for that scan in every browser, three times
	// over, on every page load.
	//
	// The cap is 200 rather than the 50 a list needs, because the dapp folds these rows into what
	// the account was worth over time and a fold has to start where the money did. Truncated at the
	// newest 50, the line would begin at whatever the 51st event left behind and claim the account
	// appeared out of nothing at that figure.
	accountActivity := activity.NewService(
		db, activity.NewRPC(cfg.RPCURL, 15*time.Second), cfg.ActivityFrom, cfg.ActivityFresh, 200)

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
			SwapTimeout:     cfg.SwapBudget,
			Chats:           chats,
			SessionSecret:   cfg.SessionSecret,
			Swap:            swapSvc,
			Index:           index,
			SwapRatePerMin:  cfg.SwapRatePerMin,
			SwapDailyMax:    cfg.SwapDailyMax,
			Graph:           subgraph,
			GraphRatePerMin: cfg.GraphRatePerMin,
			Activity:        accountActivity,
		}),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      writeTimeout,
		IdleTimeout:       60 * time.Second,
	}

	errc := make(chan error, 1)
	go func() {
		// **`models` is here so a paste can be checked without guessing.** The picker reports
		// what /api/swap/config reports, which reports what this process holds — and when a model
		// is missing from a deployment's environment the only symptom anywhere was a menu row
		// reading "not configured", with nothing to say whether the variables had been set, set on
		// the wrong application, or set without a restart. Family names only: the addresses and
		// the keys are credentials, and a log is not the place for them.
		log.Info("listening",
			"addr", cfg.Addr,
			"db", cfg.DBPath,
			"writes", cfg.AdminToken != "",
			"swap", swapSvc.Configured(),
			"models", swapSvc.Models(),
			"index", cfg.GraphMCPURL != "" && cfg.GraphMCPSubgraphID != "")
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
