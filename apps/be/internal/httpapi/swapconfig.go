package httpapi

import "net/http"

// swapConfig reports what the swap conversation is, without revealing how to reach it. A model's
// family name is not a credential; the base URL, the key and the router's own routing string are,
// or are nobody's business, and none of them is here.
//
// `models` is every model configured, in the order they are asked, and it is the list a caller
// picks from. `model` is the first of them, kept so a page built before the list existed still
// shows something true.
func (a *api) swapConfig(w http.ResponseWriter, _ *http.Request) {
	available := a.opt.Swap != nil && a.opt.Swap.Configured()
	model := ""
	models := []string{}
	if available {
		model = a.opt.Swap.Model()
		models = a.opt.Swap.Models()
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"available": available,
		"model":     model,
		"models":    models,
	})
}
