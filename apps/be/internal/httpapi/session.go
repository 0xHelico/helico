package httpapi

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/0xHelico/helico/apps/be/internal/session"
)

// SessionCookie is the cookie the browser carries. Named plainly: it is not a secret that a
// session exists, only whose it is.
const SessionCookie = "helico_session"

// maxSessionBody bounds a sign-in body. A signature is 65 bytes and a nonce is 22 characters.
const maxSessionBody = 4 << 10

// nonce hands out something to sign, and the typed data to sign it as. The backend builds the
// payload so the browser cannot quietly sign a different struct.
func (a *api) nonce(w http.ResponseWriter, r *http.Request) {
	wallet, err := session.Normalise(r.URL.Query().Get("address"))
	if err != nil {
		writeProblem(w, http.StatusBadRequest, "address must be a 20-byte hex address")
		return
	}
	now := a.now()
	value, err := a.nonces.Issue(now)
	if err != nil {
		a.opt.Logger.Error("issue nonce", "err", err, "request_id", requestIDFrom(r))
		writeProblem(w, http.StatusInternalServerError, "")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"nonce":     value,
		"issuedAt":  now.Unix(),
		"typedData": session.TypedData(wallet, value, now.Unix()),
	})
}

// signIn verifies the signature, spends the nonce, and sets the cookie.
func (a *api) signIn(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Wallet    string `json:"wallet"`
		Nonce     string `json:"nonce"`
		IssuedAt  int64  `json:"issuedAt"`
		Signature string `json:"signature"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxSessionBody)).Decode(&body); err != nil {
		writeProblem(w, http.StatusBadRequest, "send wallet, nonce, issuedAt and signature")
		return
	}
	sig, err := hex.DecodeString(strings.TrimPrefix(body.Signature, "0x"))
	if err != nil || len(sig) != 65 {
		writeProblem(w, http.StatusBadRequest, "signature must be 65 bytes of hex")
		return
	}
	now := a.now()
	// Verify before spending: a signature that does not check out should not cost the nonce,
	// or a wrong wallet could burn someone else's in-flight sign-in.
	wallet, err := session.Verify(body.Wallet, body.Nonce, body.IssuedAt, sig, now)
	if err != nil {
		writeProblem(w, http.StatusUnauthorized, verifyDetail(err))
		return
	}
	if err := a.nonces.Spend(body.Nonce, now); err != nil {
		writeProblem(w, http.StatusUnauthorized, "that nonce is unknown, already used, or expired — ask for another")
		return
	}
	value, err := a.cookies.Issue(wallet, now)
	if err != nil {
		a.opt.Logger.Error("issue cookie", "err", err, "request_id", requestIDFrom(r))
		writeProblem(w, http.StatusInternalServerError, "")
		return
	}
	http.SetCookie(w, a.sessionCookie(value, a.cookies.Life()))
	writeJSON(w, http.StatusOK, map[string]any{"address": wallet})
}

func verifyDetail(err error) string {
	switch {
	case errors.Is(err, session.ErrStale):
		return "that signature is too old — ask for a new nonce and sign again"
	case errors.Is(err, session.ErrBadSignature):
		return "that signature does not come from the address it claims"
	default:
		return "could not verify that signature"
	}
}

// whoami reports the address behind the cookie.
func (a *api) whoami(w http.ResponseWriter, r *http.Request) {
	wallet, ok := a.address(r)
	if !ok {
		writeProblem(w, http.StatusUnauthorized, "no session")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"address": wallet})
}

// signOut forgets the cookie. Stateless sessions cannot be revoked server-side, so this is
// exactly as strong as clearing it in the browser — and no weaker.
func (a *api) signOut(w http.ResponseWriter, _ *http.Request) {
	http.SetCookie(w, a.sessionCookie("", -time.Hour))
	w.WriteHeader(http.StatusNoContent)
}

// sessionCookie builds the cookie with the attributes a cross-site session needs. SameSite
// None because app.helico.site and api.helico.site are different sites, and None demands
// Secure — which browsers grant to localhost as well, so a local run behaves the same.
func (a *api) sessionCookie(value string, life time.Duration) *http.Cookie {
	return &http.Cookie{
		Name:     SessionCookie,
		Value:    value,
		Path:     "/",
		MaxAge:   int(life.Seconds()),
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteNoneMode,
	}
}

// digestForSession exists so a test can build the same digest the handler verifies, rather
// than an independent one that could agree with a mistake.
func digestForSession(wallet, nonce string, issuedAt int64) ([]byte, error) {
	return session.Digest(wallet, nonce, issuedAt)
}

// address is the caller's address, or false when there is no usable session.
func (a *api) address(r *http.Request) (string, bool) {
	c, err := r.Cookie(SessionCookie)
	if err != nil {
		return "", false
	}
	wallet, err := a.cookies.Read(c.Value, a.now())
	if err != nil {
		return "", false
	}
	return wallet, true
}

// requireSession refuses anything without one. Chat routes read the address from here and from
// nowhere else — never from the body, never from a query parameter.
func (a *api) requireSession(next func(http.ResponseWriter, *http.Request, string)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		wallet, ok := a.address(r)
		if !ok {
			writeProblem(w, http.StatusUnauthorized, "connect a wallet and sign in first")
			return
		}
		next(w, r, wallet)
	}
}
