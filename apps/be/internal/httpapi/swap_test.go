package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/0xHelico/helico/apps/be/internal/blog"
	"github.com/0xHelico/helico/apps/be/internal/store"
	"github.com/0xHelico/helico/apps/be/internal/swap"
)

// swapServer builds the API with a fake model behind the swap route. An empty key leaves the
// route unconfigured, which is the state a deployment starts in.
func swapServer(t *testing.T, key, content string, ratePerMin int) *httptest.Server {
	t.Helper()
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{"message": map[string]string{"role": "assistant", "content": content}}},
		})
	}))
	t.Cleanup(model.Close)

	db, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "api.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })

	h := New(blog.NewService(db), Options{
		Logger:         slog.New(slog.NewTextHandler(io.Discard, nil)),
		Swap:           swap.New(swap.NewClient(model.URL, key, "test-model", 5*time.Second)),
		SwapRatePerMin: ratePerMin,
		SwapDailyMax:   100,
	})
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv
}

func TestSwapIntentIsOffWithoutAKey(t *testing.T) {
	srv := swapServer(t, "", `{}`, 10)
	res, body := do(t, http.MethodPost, srv.URL+"/api/swap/intent", map[string]string{"message": "swap 1 ETH into USDC"}, nil)
	if res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503: %s", res.StatusCode, body)
	}
	if !strings.Contains(string(body), "BE_LLM_API_KEY") {
		t.Fatalf("body should say which variable turns it on: %s", body)
	}
}

func TestSwapIntentAnswersWithACheckedIntent(t *testing.T) {
	srv := swapServer(t, "k", `{"chain":"arbitrum","tokenIn":"ETH","tokenOut":"USDC","amount":"0.5"}`, 10)
	res, body := do(t, http.MethodPost, srv.URL+"/api/swap/intent", map[string]string{"message": "swap half an ETH into USDC"}, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d: %s", res.StatusCode, body)
	}
	var got struct {
		Reply  string `json:"reply"`
		Intent *struct {
			ChainID     int64                    `json:"chainId"`
			AmountInWei string                   `json:"amountInWei"`
			TokenOut    struct{ Address string } `json:"tokenOut"`
		} `json:"intent"`
	}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	if got.Intent == nil || got.Intent.ChainID != 42161 || got.Intent.AmountInWei != "500000000000000000" {
		t.Fatalf("intent = %+v", got.Intent)
	}
	if res.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("a conversation must not be cached: %q", res.Header.Get("Cache-Control"))
	}
}

func TestSwapIntentRejectsAMalformedBody(t *testing.T) {
	srv := swapServer(t, "k", `{}`, 10)
	req, err := http.NewRequest(http.MethodPost, srv.URL+"/api/swap/intent", strings.NewReader("not json"))
	if err != nil {
		t.Fatal(err)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", res.StatusCode)
	}
}

func TestSwapIntentLimitsWhatOneCallerCosts(t *testing.T) {
	srv := swapServer(t, "k", `{"chain":"arbitrum","tokenIn":"ETH","tokenOut":"USDC","amount":"1"}`, 1)
	body := map[string]string{"message": "swap 1 ETH into USDC"}
	if res, b := do(t, http.MethodPost, srv.URL+"/api/swap/intent", body, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("first call = %d: %s", res.StatusCode, b)
	}
	res, b := do(t, http.MethodPost, srv.URL+"/api/swap/intent", body, nil)
	if res.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("second call = %d, want 429: %s", res.StatusCode, b)
	}
	if res.Header.Get("Retry-After") == "" {
		t.Error("a 429 should say when to come back")
	}
}

func TestClientAddrTakesWhatTheProxyWroteNotTheCaller(t *testing.T) {
	// nginx here overwrites X-Real-IP and appends to X-Forwarded-For, so the caller controls the
	// first entry of the latter and nothing else. Counting the first entry limits nobody.
	cases := []struct {
		name       string
		realIP     string
		forwarded  string
		remoteAddr string
		want       string
	}{
		{"the header our proxy overwrites is the caller's address", "203.0.113.7", "10.0.0.1, 203.0.113.7", "127.0.0.1:5000", "203.0.113.7"},
		{"a forwarded list is ignored entirely, appended or forged", "", "10.0.0.1, 10.0.0.2, 203.0.113.9", "198.51.100.4:5000", "198.51.100.4"},
		{"no headers at all", "", "", "198.51.100.4:5000", "198.51.100.4"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "/api/swap/intent", nil)
			r.RemoteAddr = c.remoteAddr
			if c.realIP != "" {
				r.Header.Set("X-Real-IP", c.realIP)
			}
			if c.forwarded != "" {
				r.Header.Set("X-Forwarded-For", c.forwarded)
			}
			if got := clientAddr(r); got != c.want {
				t.Fatalf("clientAddr = %q, want %q", got, c.want)
			}
		})
	}
}

func TestSwapIntentLimitsAcrossForgedForwardedHeaders(t *testing.T) {
	// The probe from the review: a caller varying X-Forwarded-For must not buy extra calls.
	srv := swapServer(t, "k", `{"chain":"arbitrum","tokenIn":"ETH","tokenOut":"USDC","amount":"1"}`, 2)
	body := map[string]string{"message": "swap 1 ETH into USDC"}
	allowed := 0
	for i := range 4 {
		res, _ := do(t, http.MethodPost, srv.URL+"/api/swap/intent", body, map[string]string{
			"X-Forwarded-For": "10.0.0." + strconv.Itoa(i+1),
		})
		if res.StatusCode == http.StatusOK {
			allowed++
		}
	}
	if allowed != 2 {
		t.Fatalf("%d calls allowed against a limit of 2", allowed)
	}
}

func TestSwapIntentKeepsTheProvidersWordsOutOfTheAnswer(t *testing.T) {
	srv := swapServer(t, "k", "not json at all", 10)
	res, body := do(t, http.MethodPost, srv.URL+"/api/swap/intent", map[string]string{"message": "swap 1 ETH into USDC"}, nil)
	if res.StatusCode != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502: %s", res.StatusCode, body)
	}
	for _, leak := range []string{"127.0.0.1", "http://", "json"} {
		if strings.Contains(string(body), leak) {
			t.Fatalf("the answer carries %q: %s", leak, body)
		}
	}
}

func TestLimiterRefillsAndCapsTheDay(t *testing.T) {
	now := time.Now().UTC()
	l := newLimiter(2, 3)
	l.nowFn = func() time.Time { return now }

	for i := range 2 {
		if ok, _ := l.allow("1.2.3.4"); !ok {
			t.Fatalf("call %d was refused", i)
		}
	}
	if ok, reason := l.allow("1.2.3.4"); ok || !strings.Contains(reason, "too many") {
		t.Fatalf("third call: ok=%v reason=%q", ok, reason)
	}
	// A different caller has its own bucket, and hits the daily ceiling instead.
	if ok, _ := l.allow("5.6.7.8"); !ok {
		t.Fatal("another address should have its own allowance")
	}
	if ok, reason := l.allow("5.6.7.8"); ok || !strings.Contains(reason, "today") {
		t.Fatalf("daily ceiling: ok=%v reason=%q", ok, reason)
	}
	// A minute later the per-address bucket has refilled, and tomorrow the day resets.
	now = now.Add(time.Minute).Add(24 * time.Hour)
	if ok, reason := l.allow("1.2.3.4"); !ok {
		t.Fatalf("after a day: %q", reason)
	}
}
