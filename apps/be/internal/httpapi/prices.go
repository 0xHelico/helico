package httpapi

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/0xHelico/helico/apps/be/internal/prices"
)

// priceSeries answers what ether was worth at each hour of a window, from the Chainlink feed's
// own round history.
//
// **The past is read once.** A published round never changes, so the service keeps every sample
// it has answered and the second reader of a window costs no chain calls; only the feed's latest
// reading is fetched every time, and it is the number the headline prices with. The window is
// bounded to `prices.MaxPoints` samples so nobody can ask for a decade by the minute.
//
// One asset for now, because one asset is what a maker can hold beside USDC: the ETH/USD feed
// the dapp already sizes dollars with. The answer names it so a second feed can join later
// without the shape changing.
func (a *api) priceSeries(w http.ResponseWriter, r *http.Request) {
	if a.prices == nil {
		writeProblem(w, http.StatusServiceUnavailable, "this build has no chain endpoint, so it cannot read the price feed")
		return
	}
	if ok, reason := a.graphLimit.allow(clientAddr(r)); !ok {
		writeProblem(w, http.StatusTooManyRequests, reason)
		return
	}
	q := r.URL.Query()
	if asset := q.Get("asset"); asset != "" && asset != "WETH" && asset != "ETH" {
		writeProblem(w, http.StatusBadRequest, "only ETH is priced: ?asset=WETH")
		return
	}
	from, errFrom := strconv.ParseInt(q.Get("from"), 10, 64)
	to, errTo := strconv.ParseInt(q.Get("to"), 10, 64)
	if errFrom != nil || errTo != nil || from <= 0 || to < from {
		writeProblem(w, http.StatusBadRequest, "name the window in unix seconds: ?from=…&to=…")
		return
	}
	step := prices.Window(from, to)
	if s := q.Get("step"); s != "" {
		n, err := strconv.ParseInt(s, 10, 64)
		if err != nil || n <= 0 {
			writeProblem(w, http.StatusBadRequest, "the step is a positive number of seconds")
			return
		}
		step = n
	}
	if (to-from)/step+1 > prices.MaxPoints {
		writeProblem(w, http.StatusBadRequest, "that is more than "+strconv.Itoa(prices.MaxPoints)+" points; widen the step")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	points, err := a.prices.Series(ctx, from, to, step)
	if err != nil {
		a.opt.Logger.Error("prices", "err", err, "request_id", requestIDFrom(r))
		writeProblem(w, http.StatusBadGateway, "could not read the price feed")
		return
	}
	// A minute: the past samples never change, the latest reading moves with the feed's
	// heartbeat, and a page that reloads inside a minute is looking at the same line.
	w.Header().Set("Cache-Control", "public, max-age=60")
	writeJSON(w, http.StatusOK, map[string]any{
		"asset":  "WETH",
		"feed":   prices.Feed,
		"step":   step,
		"points": points,
	})
}
