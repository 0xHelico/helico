package httpapi

import (
	"errors"
	"fmt"
	"io"
	"net/http"

	"github.com/0xHelico/helico/apps/be/internal/graph"
)

// maxGraphBody bounds a forwarded document. The largest thing the app sends is a few hundred
// bytes of GraphQL plus a maker address.
const maxGraphBody = 16 << 10

// graphQuery answers a subgraph read, from cache when it can.
//
// It is the same shape as the endpoint it stands in front of: POST a `{query, variables}` body,
// get the subgraph's own JSON back, errors and all. That is what lets the client pick between
// this and Studio by changing a URL — and it is why the browser can still fall back to Studio
// when this process is down, which is the property the direct read had and should not lose.
func (a *api) graphQuery(w http.ResponseWriter, r *http.Request) {
	if a.graph == nil {
		writeProblem(w, http.StatusServiceUnavailable, "this build serves no subgraph cache; ask Studio directly")
		return
	}
	if refusedNonJSON(w, r) {
		return
	}
	if ok, reason := a.graphLimit.allow(clientAddr(r)); !ok {
		writeProblem(w, http.StatusTooManyRequests, reason)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxGraphBody))
	if err != nil {
		writeProblem(w, http.StatusRequestEntityTooLarge, "that document is too large")
		return
	}

	answer, hit, err := a.graph.Query(r.Context(), body)
	switch {
	case errors.Is(err, graph.ErrRefused):
		writeProblem(w, http.StatusForbidden, err.Error())
		return
	case err != nil:
		a.opt.Logger.Error("subgraph", "err", err, "request_id", requestIDFrom(r))
		writeProblem(w, http.StatusBadGateway, "the subgraph did not answer")
		return
	}

	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("Cache-Control", fmt.Sprintf("public, max-age=%d", int(a.graph.TTL().Seconds())))
	// Named so a reader can tell a served answer from a forwarded one without a stopwatch.
	if hit {
		h.Set("X-Cache", "hit")
	} else {
		h.Set("X-Cache", "miss")
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(answer)
}
