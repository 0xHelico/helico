package httpapi

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// limiter keeps a paid endpoint from being a way to spend someone else's money. It is a token
// bucket per address plus a ceiling for the whole process, both in memory: right for one
// process, and honest that it is a rate limit rather than a billing system.
type limiter struct {
	perMinute int
	dailyMax  int

	mu    sync.Mutex
	seen  map[string]*bucket
	day   time.Time
	today int
	nowFn func() time.Time
	swept time.Time
}

type bucket struct {
	tokens float64
	last   time.Time
}

func newLimiter(perMinute, dailyMax int) *limiter {
	return &limiter{perMinute: perMinute, dailyMax: dailyMax, seen: map[string]*bucket{}, nowFn: time.Now}
}

// allow reports whether this address may make one paid call now, and why not when it may not.
func (l *limiter) allow(addr string) (ok bool, reason string) {
	if l == nil || (l.perMinute <= 0 && l.dailyMax <= 0) {
		return true, ""
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.nowFn()

	if l.dailyMax > 0 {
		if day := now.UTC().Truncate(24 * time.Hour); !day.Equal(l.day) {
			l.day, l.today = day, 0
		}
		if l.today >= l.dailyMax {
			return false, "this endpoint has reached its limit for today"
		}
	}

	if l.perMinute > 0 {
		// Forget addresses that have been quiet, so a long run does not grow a map for ever.
		if now.Sub(l.swept) > 10*time.Minute {
			for k, b := range l.seen {
				if now.Sub(b.last) > 10*time.Minute {
					delete(l.seen, k)
				}
			}
			l.swept = now
		}
		b, seen := l.seen[addr]
		if !seen {
			b = &bucket{tokens: float64(l.perMinute), last: now}
			l.seen[addr] = b
		}
		b.tokens += now.Sub(b.last).Minutes() * float64(l.perMinute)
		if b.tokens > float64(l.perMinute) {
			b.tokens = float64(l.perMinute)
		}
		b.last = now
		if b.tokens < 1 {
			return false, "too many requests; try again in a moment"
		}
		b.tokens--
	}

	l.today++
	return true, ""
}

// clientAddr is the address the limiter counts.
//
// Only two things are trusted: the header our own proxy writes, and the socket. The nginx in
// front of these domains sets `X-Real-IP $remote_addr`, which **overwrites** whatever the caller
// sent, so it is the caller's real address. X-Forwarded-For is not used at all: nginx appends to
// it (`$proxy_add_x_forwarded_for`), and from inside this process an appended entry and a forged
// one look identical, so trusting any position in that list hands the limit to whoever is being
// limited. Without a proxy the socket is right anyway.
func clientAddr(r *http.Request) string {
	if real := strings.TrimSpace(r.Header.Get("X-Real-IP")); real != "" {
		return real
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
