package httpapi

import "net/http"

// swapConfig reports what the swap conversation is, without revealing how to reach it. The
// model's name is not a credential; the base URL and the key are, and neither is here.
func (a *api) swapConfig(w http.ResponseWriter, _ *http.Request) {
	available := a.opt.Swap != nil && a.opt.Swap.Configured()
	model := ""
	if available {
		model = a.opt.Swap.Model()
	}
	writeJSON(w, http.StatusOK, map[string]any{"available": available, "model": model})
}
