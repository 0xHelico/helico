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
	"github.com/0xHelico/helico/apps/be/internal/telegram"
)

type tgReader struct{ asked int }

func (r *tgReader) Holding(context.Context, string) (uint64, uint64, error) {
	r.asked++
	return 10_000, 490_081, nil
}
func (r *tgReader) Moves(context.Context, string) (int, int64, error) { r.asked++; return 1, 0, nil }

// tgServer stands up the API with a bot pointed at a fake Bot API, and hands back what that fake
// was asked to send.
func tgServer(t *testing.T, token, secret string, rate int) (*httptest.Server, *[]string, *tgReader) {
	t.Helper()
	replies := &[]string{}
	bot := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Text string `json:"text"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		*replies = append(*replies, body.Text)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(bot.Close)

	db, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "tg.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })

	read := &tgReader{}
	h := New(blog.NewService(db), Options{
		Logger:             slog.New(slog.NewTextHandler(io.Discard, nil)),
		Telegram:           telegram.New(telegram.NewClient(token, bot.URL, 5*time.Second), read),
		TelegramSecret:     secret,
		TelegramRatePerMin: rate,
	})
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv, replies, read
}

func post(t *testing.T, url, secret, body string) int {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if secret != "" {
		req.Header.Set("X-Telegram-Bot-Api-Secret-Token", secret)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	_, _ = io.ReadAll(res.Body)
	return res.StatusCode
}

const helpUpdate = `{"update_id":1,"message":{"message_id":1,"from":{"id":7},"chat":{"id":9,"type":"private"},"text":"/help"}}`

// **No token means no route.** An unconfigured deployment has no bot, so a webhook that answered
// anything at all would be surface for a feature that does not exist. 404 rather than 503: 503 says
// "this exists and is unwell", and nothing exists.
func TestWithoutATokenTheWebhookIsNotThere(t *testing.T) {
	srv, replies, _ := tgServer(t, "", "s3cret", 60)
	if code := post(t, srv.URL+"/api/telegram/webhook", "s3cret", helpUpdate); code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", code)
	}
	if len(*replies) != 0 {
		t.Errorf("it answered anyway: %v", *replies)
	}
}

// **A webhook anybody may post to is a webhook.** The secret is Telegram's own header, compared in
// constant time like the admin token.
func TestTheSecretIsRequired(t *testing.T) {
	srv, replies, read := tgServer(t, "tok", "s3cret", 60)
	for _, c := range []struct {
		name, secret string
	}{
		{"none", ""},
		{"wrong", "nope"},
		// The same length as the real one, so a comparison that leaked length would still refuse
		// this and the test would pass for the wrong reason. Both are here on purpose.
		{"wrong, same length", "s3crat"},
	} {
		if code := post(t, srv.URL+"/api/telegram/webhook", c.secret, helpUpdate); code != http.StatusUnauthorized {
			t.Errorf("%s: status = %d, want 401", c.name, code)
		}
	}
	if len(*replies) != 0 || read.asked != 0 {
		t.Errorf("something happened without the secret: %v, %d reads", *replies, read.asked)
	}
	// And with it, the bot answers.
	if code := post(t, srv.URL+"/api/telegram/webhook", "s3cret", helpUpdate); code != http.StatusOK {
		t.Fatalf("status = %d, want 200", code)
	}
	if len(*replies) != 1 || !strings.Contains((*replies)[0], "cannot move anything") {
		t.Fatalf("replies %v", *replies)
	}
}

// **A configured secret is not optional.** A deployment with a token and no secret must refuse
// every caller rather than accept every caller, which is what an empty `want` compared equal to an
// empty header would have done.
func TestATokenWithNoSecretRefusesEveryone(t *testing.T) {
	srv, replies, _ := tgServer(t, "tok", "", 60)
	for _, secret := range []string{"", "anything"} {
		if code := post(t, srv.URL+"/api/telegram/webhook", secret, helpUpdate); code != http.StatusUnauthorized {
			t.Errorf("secret %q: status = %d, want 401", secret, code)
		}
	}
	if len(*replies) != 0 {
		t.Errorf("it answered: %v", *replies)
	}
}

// **Two hundred to everything Telegram might retry.** A malformed body, an update shape this does
// not read, and a command that fails all answer 200 — the alternative is the same broken update
// arriving for hours.
func TestTelegramIsNotInvitedToRetry(t *testing.T) {
	srv, replies, _ := tgServer(t, "tok", "s3cret", 60)
	for _, c := range []struct{ name, body string }{
		{"not json", `{not json`},
		{"an empty object", `{}`},
		{"an edited message", `{"update_id":2,"edited_message":{"text":"/help"}}`},
		{"plain text", `{"update_id":3,"message":{"from":{"id":7},"chat":{"id":9,"type":"private"},"text":"hello"}}`},
		{"another bot", `{"update_id":4,"message":{"from":{"id":7,"is_bot":true},"chat":{"id":9,"type":"private"},"text":"/help"}}`},
	} {
		if code := post(t, srv.URL+"/api/telegram/webhook", "s3cret", c.body); code != http.StatusOK {
			t.Errorf("%s: status = %d, want 200", c.name, code)
		}
	}
	if len(*replies) != 0 {
		t.Errorf("it replied to something that was not a command: %v", *replies)
	}
}

// Per Telegram user rather than per address: every update arrives from Telegram's own servers, so
// an IP-keyed bucket would be one bucket for the whole world.
func TestOneUserCannotSpendTheService(t *testing.T) {
	srv, replies, _ := tgServer(t, "tok", "s3cret", 2)
	for i := 0; i < 5; i++ {
		if code := post(t, srv.URL+"/api/telegram/webhook", "s3cret", helpUpdate); code != http.StatusOK {
			t.Fatalf("status = %d", code)
		}
	}
	// Two through, and Telegram still told the updates were delivered — refusing them would have
	// it retry the same flood.
	if len(*replies) != 2 {
		t.Fatalf("%d replies, want the limit to have held at 2", len(*replies))
	}
	// A different user has their own bucket.
	other := strings.Replace(helpUpdate, `"id":7`, `"id":8`, 1)
	if code := post(t, srv.URL+"/api/telegram/webhook", "s3cret", other); code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}
	if len(*replies) != 3 {
		t.Errorf("a second user was caught by the first one's limit: %d replies", len(*replies))
	}
}
