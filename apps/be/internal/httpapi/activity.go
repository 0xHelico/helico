package httpapi

import (
	"errors"
	"fmt"
	"net/http"

	"github.com/0xHelico/helico/apps/be/internal/activity"
)

// accountActivity answers what one Helico account did, from the database when it can.
//
// **Not a proxy, unlike `/api/graph`.** That one forwards a document and keeps the answer for a
// TTL. This owns the history: an account's log is append-only, so the rows below the watermark are
// final and the only call ever needed is the one for what has happened since. The dapp was doing
// three full scans from the factory's deployment block, per visitor, per page load, against a
// public endpoint everybody shares.
//
// The rows are the fields of the events. The sentences are composed in the dapp, where the copy
// lives — a second set of English here, in another language and free to drift, is what `graph.go`
// refuses for the same reason.
func (a *api) accountActivity(w http.ResponseWriter, r *http.Request) {
	if a.activity == nil {
		writeProblem(w, http.StatusServiceUnavailable, "this build has no chain endpoint, so it cannot read an account's history")
		return
	}
	if ok, reason := a.graphLimit.allow(clientAddr(r)); !ok {
		writeProblem(w, http.StatusTooManyRequests, reason)
		return
	}
	account := r.URL.Query().Get("account")
	if account == "" {
		writeProblem(w, http.StatusBadRequest, "name the account: ?account=0x…")
		return
	}

	result, err := a.activity.For(r.Context(), account)
	switch {
	case errors.Is(err, activity.ErrBadAddress):
		writeProblem(w, http.StatusBadRequest, "that is not an address")
		return
	case err != nil:
		a.opt.Logger.Error("activity", "err", err, "request_id", requestIDFrom(r))
		writeProblem(w, http.StatusBadGateway, "could not read that account's history")
		return
	}

	h := w.Header()
	// Short, because the enclave acts every five minutes and a stale page is the thing this
	// endpoint exists to make cheap rather than to make permanent.
	h.Set("Cache-Control", "public, max-age=15")
	// Named the same way the subgraph cache names it, so one habit reads both.
	if result.Fetched {
		h.Set("X-Cache", "miss")
	} else {
		h.Set("X-Cache", "hit")
	}
	h.Set("X-Read-To", fmt.Sprintf("%d", result.ReadTo))
	writeJSON(w, http.StatusOK, result)
}
