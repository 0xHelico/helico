package httpapi

import (
	"net"
	"net/http"
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

// clientAddr is the address the limiter counts. X-Forwarded-For is trusted only for its first
// entry, because this service runs behind one proxy we control.
func clientAddr(r *http.Request) string {
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		if i := len(fwd); i > 0 {
			for j := 0; j < i; j++ {
				if fwd[j] == ',' {
					return trimSpace(fwd[:j])
				}
			}
			return trimSpace(fwd)
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func trimSpace(s string) string {
	for len(s) > 0 && (s[0] == ' ' || s[0] == '\t') {
		s = s[1:]
	}
	for len(s) > 0 && (s[len(s)-1] == ' ' || s[len(s)-1] == '\t') {
		s = s[:len(s)-1]
	}
	return s
}
