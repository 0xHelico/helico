package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/0xHelico/helico/apps/be/internal/blog"
	"github.com/0xHelico/helico/apps/be/internal/prices"
	"github.com/0xHelico/helico/apps/be/internal/store"
)

// flatFeed is an aggregator proxy with one round an hour in phase 1, every answer $2,000 plus
// the round number in dollars, so a sample's price names the round it came from.
type flatFeed struct{ n uint64 }

func (f flatFeed) EthCall(_ context.Context, _ string, data string) (string, error) {
	word := func(v *big.Int) string { return fmt.Sprintf("%064x", v) }
	encode := func(agg uint64) string {
		id := new(big.Int).Or(new(big.Int).Lsh(big.NewInt(1), 64), new(big.Int).SetUint64(agg))
		updated := big.NewInt(1_699_999_200 + int64(agg-1)*3600) // on the hour
		return "0x" + word(id) + word(big.NewInt(2000_00000000+int64(agg)*100000000)) + word(updated) + word(updated) + word(id)
	}
	switch {
	case strings.HasPrefix(data, "0x313ce567"):
		return "0x" + fmt.Sprintf("%064x", 8), nil
	case strings.HasPrefix(data, "0xfeaf968c"):
		return encode(f.n), nil
	case strings.HasPrefix(data, "0x9a6fc8f5"):
		id, _ := new(big.Int).SetString(strings.TrimPrefix(data, "0x9a6fc8f5"), 16)
		agg := new(big.Int).And(id, new(big.Int).SetUint64(^uint64(0))).Uint64()
		if new(big.Int).Rsh(id, 64).Uint64() != 1 || agg == 0 || agg > f.n {
			return "", fmt.Errorf("execution reverted")
		}
		return encode(agg), nil
	}
	return "", fmt.Errorf("unexpected selector")
}

func (f flatFeed) EthCalls(ctx context.Context, to string, data []string) ([]string, error) {
	out := make([]string, len(data))
	for i, d := range data {
		raw, err := f.EthCall(ctx, to, d)
		if err != nil && !strings.Contains(err.Error(), "revert") {
			return nil, err
		}
		out[i] = raw
	}
	return out, nil
}

func pricesServer(t *testing.T, svc *prices.Service) *httptest.Server {
	t.Helper()
	db, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "api.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	h := New(blog.NewService(db), Options{
		Logger:          slog.New(slog.NewTextHandler(io.Discard, nil)),
		Prices:          svc,
		GraphRatePerMin: 60,
	})
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv
}

func TestThePriceRouteAnswersTheFeedsRounds(t *testing.T) {
	srv := pricesServer(t, prices.New(flatFeed{n: 100}, ""))
	from := int64(1_699_999_200 + 10*3600)
	to := from + 5*3600
	res, body := do(t, http.MethodGet, fmt.Sprintf("%s/api/prices?asset=WETH&from=%d&to=%d", srv.URL, from, to), nil, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d: %s", res.StatusCode, body)
	}
	if cc := res.Header.Get("Cache-Control"); !strings.Contains(cc, "max-age=60") {
		t.Fatalf("Cache-Control = %q", cc)
	}
	var got struct {
		Asset  string `json:"asset"`
		Feed   string `json:"feed"`
		Step   int64  `json:"step"`
		Points []struct {
			T     int64   `json:"t"`
			Price float64 `json:"price"`
			Round string  `json:"round"`
		} `json:"points"`
	}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	if got.Asset != "WETH" || got.Feed != prices.Feed || got.Step != 3600 {
		t.Fatalf("header fields: %+v", got)
	}
	// Six hourly samples (rounds 11..16, each exactly on its round) and the feed's latest.
	if len(got.Points) != 7 {
		t.Fatalf("points = %d: %+v", len(got.Points), got.Points)
	}
	for i, p := range got.Points[:6] {
		if want := 2000 + float64(11+i); p.Price != want || p.T != from+int64(i)*3600 {
			t.Errorf("point %d = %+v, want price %.0f at %d", i, p, want, from+int64(i)*3600)
		}
	}
	if last := got.Points[6]; last.Price != 2100 {
		t.Errorf("the last point is not the feed's latest: %+v", last)
	}
}

func TestThePriceRouteRefusesABadWindow(t *testing.T) {
	srv := pricesServer(t, prices.New(flatFeed{n: 100}, ""))
	for _, q := range []string{
		"",
		"from=abc&to=2",
		"from=200&to=100",
		"from=1&to=2&step=0",
		"from=1&to=2&asset=BTC",
		fmt.Sprintf("from=1&to=%d&step=1", prices.MaxPoints+5),
	} {
		res, body := do(t, http.MethodGet, srv.URL+"/api/prices?"+q, nil, nil)
		if res.StatusCode != http.StatusBadRequest {
			t.Errorf("%q: status = %d: %s", q, res.StatusCode, body)
		}
	}
}

func TestWithoutAChainEndpointThePriceRouteSaysSo(t *testing.T) {
	srv := pricesServer(t, nil)
	res, body := do(t, http.MethodGet, srv.URL+"/api/prices?from=1&to=2", nil, nil)
	if res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d: %s", res.StatusCode, body)
	}
}
