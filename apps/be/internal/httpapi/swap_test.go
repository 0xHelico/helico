package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
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
