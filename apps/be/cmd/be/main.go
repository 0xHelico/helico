// Command be serves Helico's blog: posts in SQLite, seeded from Markdown files, over a small
// JSON API. Configuration is BE_* environment variables; see internal/config.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/0xHelico/helico/apps/be/internal/blog"
	"github.com/0xHelico/helico/apps/be/internal/chat"
	"github.com/0xHelico/helico/apps/be/internal/config"
	"github.com/0xHelico/helico/apps/be/internal/content"
	"github.com/0xHelico/helico/apps/be/internal/httpapi"
	"github.com/0xHelico/helico/apps/be/internal/store"
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

	svc := blog.NewService(db)
	chats := chat.NewService(db)
	if cfg.SessionSecret == "" {
		log.Warn("BE_SESSION_SECRET is unset; the cookie key is random, so every restart signs everyone out")
	}
	if n, err := content.Seed(ctx, cfg.ContentDir, svc); err != nil {
		return fmt.Errorf("seed: %w", err)
	} else if n > 0 {
		log.Info("seeded posts", "written", n, "dir", cfg.ContentDir)
	}

	srv := &http.Server{
		Addr: cfg.Addr,
		Handler: httpapi.New(svc, httpapi.Options{
			AdminToken:     cfg.AdminToken,
			CORSOrigins:    cfg.CORSOrigins,
			Logger:         log,
			RequestTimeout: cfg.RequestTimeout,
			Chats:          chats,
			SessionSecret:  cfg.SessionSecret,
		}),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      cfg.RequestTimeout + 5*time.Second,
		IdleTimeout:       60 * time.Second,
	}

	errc := make(chan error, 1)
	go func() {
		log.Info("listening", "addr", cfg.Addr, "db", cfg.DBPath, "writes", cfg.AdminToken != "")
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
