package httpapi

import (
	"crypto/subtle"
	"encoding/json"
	"io"
	"net/http"
	"strconv"

	"github.com/0xHelico/helico/apps/be/internal/telegram"
)

/*
The Bot API's webhook.

**A webhook rather than long polling**, because the VPS already terminates TLS and Coolify already
runs this process. Long polling is a loop that must never sleep, and a restart mid-poll either
drops updates or replays them.

**Not served at all when there is no token.** An unconfigured deployment has no bot, so a route
that answered anything would be surface for a feature that does not exist. 404 rather than 503:
503 says "this exists and is unwell", and nothing exists.

**Two hundred to almost everything else.** Telegram retries an update it considers undelivered, so
a malformed body, an update shape this does not read and a command that fails all answer 200 with
an empty body. The alternative is the same broken update arriving for hours. The exception is a
missing or wrong secret, which is answered 401 and never retried into — a caller without the secret
is not Telegram.
*/
func (a *api) telegramWebhook(w http.ResponseWriter, r *http.Request) {
	if a.opt.Telegram == nil || !a.opt.Telegram.Configured() {
		writeProblem(w, http.StatusNotFound, "")
		return
	}

	// Constant time, like the admin token. A length-leaking comparison on a shared secret is the
	// same mistake in a second place.
	sent := r.Header.Get("X-Telegram-Bot-Api-Secret-Token")
	want := a.opt.TelegramSecret
	if want == "" || subtle.ConstantTimeCompare([]byte(sent), []byte(want)) != 1 {
		writeProblem(w, http.StatusUnauthorized, "")
		return
	}

	// Bounded: an update carrying a megabyte is an update that misunderstood.
	raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		w.WriteHeader(http.StatusOK)
		return
	}
	var update telegram.Update
	if err := json.Unmarshal(raw, &update); err != nil {
		a.opt.Logger.Warn("telegram sent something that is not an update", "error", err)
		w.WriteHeader(http.StatusOK)
		return
	}
	cmd, ok := telegram.Parse(update)
	if !ok {
		// A photo, an edited message, another bot, a shape invented after this was written. Not an
		// error and not something to answer.
		w.WriteHeader(http.StatusOK)
		return
	}

	// **Keyed on the Telegram user, not on an address.** Every update arrives from Telegram's own
	// servers, so `clientAddr` is the same for everybody and an IP-keyed bucket would be one
	// bucket for the whole world. The limit is per person asking.
	if ok, _ := a.telegramLimit.allow("tg:" + strconv.FormatInt(cmd.User, 10)); !ok {
		a.opt.Logger.Warn("telegram user is over the limit", "user", cmd.User)
		w.WriteHeader(http.StatusOK)
		return
	}

	if err := a.opt.Telegram.Handle(r.Context(), cmd); err != nil {
		// The reply not sending is this service's problem to own. Telegram is told the update was
		// delivered, because it was — retrying would send the same failing reply again.
		a.opt.Logger.Warn("telegram reply failed", "command", cmd.Name, "error", err)
	}
	w.WriteHeader(http.StatusOK)
}
