package httpapi

import (
	"bufio"
	"compress/gzip"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// recoverer turns a panic into a 500 with a log line instead of a dropped connection.
func recoverer(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if rec := recover(); rec != nil {
					log.Error("panic", "err", rec, "path", r.URL.Path, "request_id", requestIDFrom(r))
					writeProblem(w, http.StatusInternalServerError, "")
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}

const requestIDHeader = "X-Request-Id"

// requestID echoes a client's id or mints one, and puts it on the response.
func requestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get(requestIDHeader)
		if id == "" || len(id) > 64 {
			var b [8]byte
			_, _ = rand.Read(b[:])
			id = hex.EncodeToString(b[:])
			r.Header.Set(requestIDHeader, id)
		}
		w.Header().Set(requestIDHeader, id)
		next.ServeHTTP(w, r)
	})
}

func requestIDFrom(r *http.Request) string { return r.Header.Get(requestIDHeader) }

// statusWriter remembers the status and size for the access log.
type statusWriter struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (w *statusWriter) WriteHeader(code int) {
	if w.status == 0 {
		w.status = code
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	n, err := w.ResponseWriter.Write(b)
	w.bytes += n
	return n, err
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if h, ok := w.ResponseWriter.(http.Hijacker); ok {
		return h.Hijack()
	}
	return nil, nil, http.ErrNotSupported
}

// logging writes one structured line per request.
func logging(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			sw := &statusWriter{ResponseWriter: w}
			next.ServeHTTP(sw, r)
			log.Info("request",
				"method", r.Method, "path", r.URL.Path, "status", sw.status, "bytes", sw.bytes,
				"duration_ms", time.Since(start).Milliseconds(), "request_id", requestIDFrom(r))
		})
	}
}

// cors allows the configured browser origins to read the API and, with a token, write it.
func cors(origins []string) func(http.Handler) http.Handler {
	allowed := make(map[string]bool, len(origins))
	for _, o := range origins {
		allowed[strings.TrimRight(o, "/")] = true
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if origin := r.Header.Get("Origin"); origin != "" && allowed[origin] {
				h := w.Header()
				h.Set("Access-Control-Allow-Origin", origin)
				h.Add("Vary", "Origin")
				h.Set("Access-Control-Allow-Methods", "GET, PUT, DELETE, OPTIONS")
				h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type, If-None-Match")
				h.Set("Access-Control-Expose-Headers", "ETag, X-Request-Id")
				h.Set("Access-Control-Max-Age", "600")
				if r.Method == http.MethodOptions {
					w.WriteHeader(http.StatusNoContent)
					return
				}
			}
			next.ServeHTTP(w, r)
		})
	}
}

// gzipMinBytes is the size below which compressing costs more than it saves.
const gzipMinBytes = 1024

var gzipPool = sync.Pool{New: func() any { return gzip.NewWriter(nil) }}

// gzipper compresses JSON responses of at least gzipMinBytes when the client accepts it. It
// buffers the first kilobyte to decide, so small bodies go out untouched.
func gzipper(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			next.ServeHTTP(w, r)
			return
		}
		gw := &gzipWriter{ResponseWriter: w}
		defer gw.close()
		next.ServeHTTP(gw, r)
	})
}

type gzipWriter struct {
	http.ResponseWriter
	status  int
	buf     []byte
	decided bool
	gz      *gzip.Writer
}

func (g *gzipWriter) WriteHeader(code int) { g.status = code }

func (g *gzipWriter) Write(b []byte) (int, error) {
	if g.decided {
		if g.gz != nil {
			return g.gz.Write(b)
		}
		return g.ResponseWriter.Write(b)
	}
	g.buf = append(g.buf, b...)
	if len(g.buf) >= gzipMinBytes {
		return len(b), g.decide(true)
	}
	return len(b), nil
}

func (g *gzipWriter) Unwrap() http.ResponseWriter { return g.ResponseWriter }

// decide picks plain or gzip once and flushes what was buffered.
func (g *gzipWriter) decide(compress bool) error {
	g.decided = true
	if g.status == 0 {
		g.status = http.StatusOK
	}
	ct := g.Header().Get("Content-Type")
	compress = compress && (strings.HasPrefix(ct, "application/json") || strings.HasPrefix(ct, "application/problem+json"))
	if compress {
		g.Header().Set("Content-Encoding", "gzip")
		g.Header().Add("Vary", "Accept-Encoding")
		g.Header().Del("Content-Length")
		g.gz = gzipPool.Get().(*gzip.Writer)
		g.gz.Reset(g.ResponseWriter)
	}
	g.ResponseWriter.WriteHeader(g.status)
	var err error
	if g.gz != nil {
		_, err = g.gz.Write(g.buf)
	} else {
		_, err = g.ResponseWriter.Write(g.buf)
	}
	g.buf = nil
	return err
}

func (g *gzipWriter) close() {
	if !g.decided {
		_ = g.decide(false)
	}
	if g.gz != nil {
		_ = g.gz.Close()
		gzipPool.Put(g.gz)
		g.gz = nil
	}
}
