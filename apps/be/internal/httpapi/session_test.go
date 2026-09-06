package httpapi

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"
	"github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
	"golang.org/x/crypto/sha3"

	"github.com/0xHelico/helico/apps/be/internal/blog"
	"github.com/0xHelico/helico/apps/be/internal/chat"
	"github.com/0xHelico/helico/apps/be/internal/store"
)

// Two throwaway keys. They sign nothing but these tests.
const (
	keyAHex = "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318"
	keyBHex = "8da4ef21b864d2cc526dbdb2a120bd2874c36c9d0a1fb7f8c63d7f7a8b41de8f"
)

func newChatServer(t *testing.T) *httptest.Server {
	t.Helper()
	db, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "api.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	h := New(blog.NewService(db), Options{
		CORSOrigins:   []string{"http://localhost:3000"},
		Logger:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		Chats:         chat.NewService(db),
		SessionSecret: "a-test-secret",
	})
	// TLS, because the session cookie is Secure and Go's cookie jar — unlike a browser, which
	// makes an exception for localhost — will not send one over plain HTTP. Production is
	// HTTPS, so this is the faithful shape anyway.
	srv := httptest.NewTLSServer(h)
	t.Cleanup(srv.Close)
	return srv
}

// wallet is a signer that behaves like a browser wallet.
type wallet struct {
	key  *secp256k1.PrivateKey
	addr string
}

func newWallet(t *testing.T, keyHex string) wallet {
	t.Helper()
	raw, err := hex.DecodeString(keyHex)
	if err != nil {
		t.Fatal(err)
	}
	key := secp256k1.PrivKeyFromBytes(raw)
	h := sha3.NewLegacyKeccak256()
	h.Write(key.PubKey().SerializeUncompressed()[1:])
	return wallet{key: key, addr: "0x" + hex.EncodeToString(h.Sum(nil)[12:])}
}

// signIn walks the whole handshake and returns a client carrying the session cookie.
func (w wallet) signIn(t *testing.T, srv *httptest.Server) *http.Client {
	t.Helper()
	// A client of its own: httptest.Server.Client() hands back the same one every time, so two
	// wallets sharing it would share a cookie jar and the test would prove nothing.
	shared := srv.Client()
	client := &http.Client{Transport: shared.Transport, Jar: newJar(t)}

	res, err := client.Get(srv.URL + "/api/session/nonce?address=" + w.addr)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("nonce: %d", res.StatusCode)
	}
	var challenge struct {
		Nonce    string `json:"nonce"`
		IssuedAt int64  `json:"issuedAt"`
	}
	if err := json.NewDecoder(res.Body).Decode(&challenge); err != nil {
		t.Fatal(err)
	}

	sig := w.sign(t, digestFor(t, w.addr, challenge.Nonce, challenge.IssuedAt))
	body, _ := json.Marshal(map[string]any{
		"wallet": w.addr, "nonce": challenge.Nonce, "issuedAt": challenge.IssuedAt,
		"signature": "0x" + hex.EncodeToString(sig),
	})
	res2, err := client.Post(srv.URL+"/api/session", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer res2.Body.Close()
	if res2.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(res2.Body)
		t.Fatalf("sign in: %d %s", res2.StatusCode, msg)
	}
	return client
}

func (w wallet) sign(t *testing.T, digest []byte) []byte {
	t.Helper()
	compact := ecdsa.SignCompact(w.key, digest, false)
	sig := make([]byte, 65)
	copy(sig, compact[1:])
	sig[64] = compact[0]
	return sig
}

func digestFor(t *testing.T, addr, nonce string, issuedAt int64) []byte {
	t.Helper()
	// Through the same package the server uses, so the test cannot agree with a wrong digest.
	d, err := digestForSession(addr, nonce, issuedAt)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func TestSignInGivesASessionAndSignOutTakesItBack(t *testing.T) {
	srv := newChatServer(t)
	alice := newWallet(t, keyAHex)
	client := alice.signIn(t, srv)

	var who struct {
		Address string `json:"address"`
	}
	res, err := client.Get(srv.URL + "/api/session")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.NewDecoder(res.Body).Decode(&who); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if who.Address != alice.addr {
		t.Fatalf("session says %s, want %s", who.Address, alice.addr)
	}

	req, _ := http.NewRequest(http.MethodDelete, srv.URL+"/api/session", nil)
	out, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	out.Body.Close()
	after, err := client.Get(srv.URL + "/api/session")
	if err != nil {
		t.Fatal(err)
	}
	after.Body.Close()
	if after.StatusCode != http.StatusUnauthorized {
		t.Fatalf("after signing out: %d, want 401", after.StatusCode)
	}
}

func TestANonceCannotBeUsedTwice(t *testing.T) {
	srv := newChatServer(t)
	alice := newWallet(t, keyAHex)
	client := srv.Client()

	res, _ := client.Get(srv.URL + "/api/session/nonce?address=" + alice.addr)
	var challenge struct {
		Nonce    string `json:"nonce"`
		IssuedAt int64  `json:"issuedAt"`
	}
	_ = json.NewDecoder(res.Body).Decode(&challenge)
	res.Body.Close()

	sig := alice.sign(t, digestFor(t, alice.addr, challenge.Nonce, challenge.IssuedAt))
	body, _ := json.Marshal(map[string]any{
		"wallet": alice.addr, "nonce": challenge.Nonce, "issuedAt": challenge.IssuedAt,
		"signature": "0x" + hex.EncodeToString(sig),
	})
	first, _ := client.Post(srv.URL+"/api/session", "application/json", bytes.NewReader(body))
	first.Body.Close()
	if first.StatusCode != http.StatusOK {
		t.Fatalf("first sign in: %d", first.StatusCode)
	}
	// The same signature again, which is exactly what a replay looks like.
	second, _ := client.Post(srv.URL+"/api/session", "application/json", bytes.NewReader(body))
	second.Body.Close()
	if second.StatusCode != http.StatusUnauthorized {
		t.Fatalf("replay: %d, want 401", second.StatusCode)
	}
}

func TestChatRoutesRefuseWithoutASession(t *testing.T) {
	srv := newChatServer(t)
	client := srv.Client()
	for _, c := range []struct{ method, path string }{
		{http.MethodGet, "/api/chats"},
		{http.MethodPost, "/api/chats"},
		{http.MethodDelete, "/api/chats"},
		{http.MethodGet, "/api/chats/anything"},
		{http.MethodPost, "/api/chats/anything/messages"},
		{http.MethodDelete, "/api/chats/anything"},
	} {
		req, _ := http.NewRequest(c.method, srv.URL+c.path, nil)
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusUnauthorized {
			t.Fatalf("%s %s: %d, want 401", c.method, c.path, res.StatusCode)
		}
	}
}

func TestOneWalletCannotReachAnothersConversation(t *testing.T) {
	srv := newChatServer(t)
	alice := newWallet(t, keyAHex)
	bob := newWallet(t, keyBHex)
	if alice.addr == bob.addr {
		t.Fatal("the two test keys must be different")
	}
	aliceClient := alice.signIn(t, srv)
	bobClient := bob.signIn(t, srv)

	body, _ := json.Marshal(map[string]string{"message": "Swap half an ETH into USDC"})
	res, err := aliceClient.Post(srv.URL+"/api/chats", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	var created struct {
		ID string `json:"id"`
	}
	_ = json.NewDecoder(res.Body).Decode(&created)
	res.Body.Close()
	if created.ID == "" {
		t.Fatal("no conversation id came back")
	}

	// Bob has a valid session of his own, which is the interesting case: authenticated, and
	// still not entitled. And 404 rather than 403, so he does not learn it exists.
	for _, c := range []struct{ method, path string }{
		{http.MethodGet, "/api/chats/" + created.ID},
		{http.MethodDelete, "/api/chats/" + created.ID},
	} {
		req, _ := http.NewRequest(c.method, srv.URL+c.path, nil)
		out, err := bobClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		out.Body.Close()
		if out.StatusCode != http.StatusNotFound {
			t.Fatalf("bob %s %s: %d, want 404", c.method, c.path, out.StatusCode)
		}
	}
	msg, _ := json.Marshal(map[string]string{"role": "user", "body": "intruding"})
	out, err := bobClient.Post(srv.URL+"/api/chats/"+created.ID+"/messages", "application/json", bytes.NewReader(msg))
	if err != nil {
		t.Fatal(err)
	}
	out.Body.Close()
	if out.StatusCode != http.StatusNotFound {
		t.Fatalf("bob appending: %d, want 404", out.StatusCode)
	}

	// Bob's own list is empty, and Alice's conversation is untouched.
	list, err := bobClient.Get(srv.URL + "/api/chats")
	if err != nil {
		t.Fatal(err)
	}
	var bobsList struct {
		Conversations []map[string]any `json:"conversations"`
	}
	_ = json.NewDecoder(list.Body).Decode(&bobsList)
	list.Body.Close()
	if len(bobsList.Conversations) != 0 {
		t.Fatalf("bob sees %d conversations", len(bobsList.Conversations))
	}
}

func TestAConversationSurvivesAndComesBackInOrder(t *testing.T) {
	srv := newChatServer(t)
	alice := newWallet(t, keyAHex)
	client := alice.signIn(t, srv)

	body, _ := json.Marshal(map[string]string{"message": "Swap half an ETH into USDC"})
	res, _ := client.Post(srv.URL+"/api/chats", "application/json", bytes.NewReader(body))
	var created struct{ ID, Title string }
	_ = json.NewDecoder(res.Body).Decode(&created)
	res.Body.Close()
	if created.Title != "Swap half an ETH into USDC" {
		t.Fatalf("title %q", created.Title)
	}

	for _, m := range []map[string]any{
		{"role": "user", "body": "Swap half an ETH into USDC"},
		{"role": "assistant", "body": "Swapping 0.5 ETH into USDC", "intent": map[string]any{"chainId": 42161}},
	} {
		raw, _ := json.Marshal(m)
		out, err := client.Post(srv.URL+"/api/chats/"+created.ID+"/messages", "application/json", bytes.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		out.Body.Close()
		if out.StatusCode != http.StatusCreated {
			t.Fatalf("append: %d", out.StatusCode)
		}
	}

	// A brand-new client with the same cookie jar is what a page reload looks like.
	read, err := client.Get(srv.URL + "/api/chats/" + created.ID)
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Messages []struct {
			Role   string          `json:"role"`
			Body   string          `json:"body"`
			Intent json.RawMessage `json:"intent"`
		} `json:"messages"`
	}
	_ = json.NewDecoder(read.Body).Decode(&got)
	read.Body.Close()
	if len(got.Messages) != 2 || got.Messages[0].Role != "user" || got.Messages[1].Role != "assistant" {
		t.Fatalf("messages %+v", got.Messages)
	}
	if string(got.Messages[1].Intent) != `{"chainId":42161}` {
		t.Fatalf("intent %s", got.Messages[1].Intent)
	}
}
