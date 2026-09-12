package telegram

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// sent is what the fake Bot API was asked to deliver.
type sent struct {
	Chat int64  `json:"chat_id"`
	Text string `json:"text"`
}

func fakeBot(t *testing.T) (*Client, *[]sent) {
	t.Helper()
	out := &[]sent{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The token belongs in the path and nowhere else.
		if !strings.HasPrefix(r.URL.Path, "/bottest-token/") {
			t.Errorf("called %s, want the token in the path", r.URL.Path)
		}
		var body sent
		_ = json.NewDecoder(r.Body).Decode(&body)
		*out = append(*out, body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(srv.Close)
	return NewClient("test-token", srv.URL, 5*time.Second), out
}

// stub answers what the commands read.
type stub struct {
	idle, working uint64
	count         int
	last          int64
	err           error
	asked         []string
}

func (s *stub) Holding(_ context.Context, owner string) (uint64, uint64, error) {
	s.asked = append(s.asked, owner)
	return s.idle, s.working, s.err
}
func (s *stub) Moves(_ context.Context, owner string) (int, int64, error) {
	s.asked = append(s.asked, owner)
	return s.count, s.last, s.err
}

func update(text, chatType string, from int64, isBot bool) Update {
	var u Update
	raw := `{"update_id":1,"message":{"message_id":2,"from":{"id":` +
		itoa(from) + `,"is_bot":` + boolStr(isBot) + `},"chat":{"id":99,"type":"` + chatType + `"},"text":` +
		quote(text) + `}}`
	if err := json.Unmarshal([]byte(raw), &u); err != nil {
		panic(err)
	}
	return u
}

func itoa(v int64) string { b, _ := json.Marshal(v); return string(b) }
func boolStr(b bool) string {
	if b {
		return "true"
	}
	return "false"
}
func quote(s string) string { b, _ := json.Marshal(s); return string(b) }

// **Every field of an update is optional, and none of them may panic.** Telegram sends edited
// messages, channel posts, poll answers and shapes invented after this was written, and it retries
// anything it thinks was not delivered — so a nil dereference here is an infinite loop of crashes.
func TestParseRefusesEverythingThatIsNotACommandFromAPerson(t *testing.T) {
	for _, c := range []struct {
		name string
		raw  string
	}{
		{"an empty object", `{}`},
		{"an update with no message", `{"update_id":1}`},
		{"a message with no chat", `{"message":{"from":{"id":7},"text":"/help"}}`},
		{"a message with no sender", `{"message":{"chat":{"id":1,"type":"private"},"text":"/help"}}`},
		{"plain text", `{"message":{"from":{"id":7},"chat":{"id":1,"type":"private"},"text":"hello"}}`},
		{"a photo with no text", `{"message":{"from":{"id":7},"chat":{"id":1,"type":"private"}}}`},
		{"a slash on its own", `{"message":{"from":{"id":7},"chat":{"id":1,"type":"private"},"text":"/"}}`},
		{"another bot", `{"message":{"from":{"id":7,"is_bot":true},"chat":{"id":1,"type":"private"},"text":"/help"}}`},
	} {
		var u Update
		if err := json.Unmarshal([]byte(c.raw), &u); err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if _, ok := Parse(u); ok {
			t.Errorf("%s was read as a command", c.name)
		}
	}
}

// Telegram appends the bot's username in group chats. A parser that did not strip it would answer
// nothing in exactly the place where several bots are listening.
func TestParseStripsTheBotsOwnUsernameAndLowerCases(t *testing.T) {
	cmd, ok := Parse(update("/PortFolio@HelicoBot 0xABC extra", "group", 7, false))
	if !ok {
		t.Fatal("not read as a command")
	}
	if cmd.Name != "portfolio" {
		t.Errorf("name %q", cmd.Name)
	}
	if len(cmd.Args) != 2 || cmd.Args[0] != "0xABC" {
		t.Errorf("args %v", cmd.Args)
	}
	if cmd.Private {
		t.Error("a group is not private")
	}
	if cmd.Chat != 99 || cmd.User != 7 {
		t.Errorf("chat %d user %d", cmd.Chat, cmd.User)
	}
}

// **A group chat answers nothing personal.** Nothing in this slice is personal, so this is not
// protecting anything yet — it is here so it is already true on the day a linked wallet's balances
// become answerable, rather than being the thing somebody remembers to add.
func TestAGroupIsRefusedWithoutReadingAnything(t *testing.T) {
	client, out := fakeBot(t)
	read := &stub{idle: 1_000_000}
	cmd, _ := Parse(update("/portfolio 0x0acdfa21a3cd075aee6583c8a8069f86ad3e4a39", "group", 7, false))
	if err := New(client, read).Handle(context.Background(), cmd); err != nil {
		t.Fatal(err)
	}
	if len(*out) != 1 || !strings.Contains((*out)[0].Text, "direct message") {
		t.Fatalf("reply %+v", *out)
	}
	if len(read.asked) != 0 {
		t.Errorf("a group read the chain: %v", read.asked)
	}
}

func TestHelpSaysWhatItCannotDoBeforeWhatItCan(t *testing.T) {
	client, out := fakeBot(t)
	for _, name := range []string{"/start", "/help"} {
		cmd, _ := Parse(update(name, "private", 7, false))
		if err := New(client, &stub{}).Handle(context.Background(), cmd); err != nil {
			t.Fatal(err)
		}
	}
	if len(*out) != 2 {
		t.Fatalf("%d replies", len(*out))
	}
	text := (*out)[0].Text
	// The claim that matters. A bot that talks about money has to say it cannot move any, and say
	// it before the list of what it does.
	if !strings.Contains(text, "cannot move anything") {
		t.Errorf("help does not say it cannot move anything:\n%s", text)
	}
	if i, j := strings.Index(text, "cannot move anything"), strings.Index(text, "/portfolio"); i > j {
		t.Error("it lists commands before saying what it cannot do")
	}
	if !strings.Contains(text, "holds no key") {
		t.Errorf("help does not say it holds no key:\n%s", text)
	}
}

func TestAnAddressIsRequiredRatherThanGuessed(t *testing.T) {
	client, out := fakeBot(t)
	read := &stub{idle: 5_000_000}
	for _, text := range []string{"/portfolio", "/portfolio notanaddress", "/portfolio 0x123"} {
		cmd, _ := Parse(update(text, "private", 7, false))
		if err := New(client, read).Handle(context.Background(), cmd); err != nil {
			t.Fatal(err)
		}
	}
	if len(read.asked) != 0 {
		t.Errorf("something was read for a command with no address: %v", read.asked)
	}
	for _, s := range *out {
		if !strings.Contains(s.Text, "needs an address") {
			t.Errorf("reply %q", s.Text)
		}
	}
}

func TestAHoldingIsFormattedFromBaseUnits(t *testing.T) {
	client, out := fakeBot(t)
	read := &stub{idle: 10_000, working: 490_081}
	cmd, _ := Parse(update("/portfolio 0x0AcdFa21a3cD075aee6583c8A8069F86ad3e4a39", "private", 7, false))
	if err := New(client, read).Handle(context.Background(), cmd); err != nil {
		t.Fatal(err)
	}
	text := (*out)[0].Text
	// The live account's own figures: 0.01 liquid and 0.49 earning, half a dollar in total.
	for _, want := range []string{"0.50 USDC", "0.01 liquid", "0.49 earning"} {
		if !strings.Contains(text, want) {
			t.Errorf("reply has no %q:\n%s", want, text)
		}
	}
	// Lower-cased on the way to the reader, because an address is a key in two filters downstream.
	if read.asked[0] != "0x0acdfa21a3cd075aee6583c8a8069f86ad3e4a39" {
		t.Errorf("asked for %q", read.asked[0])
	}
}

// Zero is a measurement and says so. An account read and found empty is a different fact from an
// account nobody could read, and the two must not share a sentence.
func TestAnEmptyAccountAndAnUnreadableOneSayDifferentThings(t *testing.T) {
	client, out := fakeBot(t)
	empty, _ := Parse(update("/portfolio 0x0acdfa21a3cd075aee6583c8a8069f86ad3e4a39", "private", 7, false))
	if err := New(client, &stub{}).Handle(context.Background(), empty); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains((*out)[0].Text, "holds nothing yet") {
		t.Errorf("empty: %q", (*out)[0].Text)
	}
	if err := New(client, &stub{err: context.DeadlineExceeded}).Handle(context.Background(), empty); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains((*out)[1].Text, "did not answer") {
		t.Errorf("unreadable: %q", (*out)[1].Text)
	}
}

func TestMovesCountsAndDates(t *testing.T) {
	client, out := fakeBot(t)
	cmd, _ := Parse(update("/moves 0x0acdfa21a3cd075aee6583c8a8069f86ad3e4a39", "private", 7, false))
	if err := New(client, &stub{count: 1, last: 1_789_126_222}).Handle(context.Background(), cmd); err != nil {
		t.Fatal(err)
	}
	text := (*out)[0].Text
	if !strings.Contains(text, "1 time") || strings.Contains(text, "1 times") {
		t.Errorf("singular is wrong: %q", text)
	}
	// A real stamp, not Discord's `<t:…>` markup, which the first version of this used and which
	// Telegram would have printed literally.
	if strings.Contains(text, "<t:") {
		t.Errorf("markup Telegram does not have: %q", text)
	}
	if !strings.Contains(text, "UTC") {
		t.Errorf("no readable time: %q", text)
	}
	if err := New(client, &stub{}).Handle(context.Background(), cmd); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains((*out)[1].Text, "has not moved anything") {
		t.Errorf("never moved: %q", (*out)[1].Text)
	}
}

// A bot that says nothing to an unknown command is indistinguishable from a bot that is down.
func TestAnUnknownCommandIsAnsweredRatherThanIgnored(t *testing.T) {
	client, out := fakeBot(t)
	cmd, _ := Parse(update("/wen", "private", 7, false))
	if err := New(client, &stub{}).Handle(context.Background(), cmd); err != nil {
		t.Fatal(err)
	}
	if len(*out) != 1 || !strings.Contains((*out)[0].Text, "/help") {
		t.Fatalf("reply %+v", *out)
	}
}

func TestNoTokenIsNoBot(t *testing.T) {
	s := New(NewClient("", "", 0), &stub{})
	if s.Configured() {
		t.Error("a client with no token is not configured")
	}
	cmd, _ := Parse(update("/help", "private", 7, false))
	if err := s.Handle(context.Background(), cmd); err != ErrNotConfigured {
		t.Errorf("err = %v", err)
	}
	// And a service with no reader cannot answer either, so it is not a route worth exposing.
	if New(NewClient("t", "", 0), nil).Configured() {
		t.Error("a service with no reader is not configured")
	}
}

// The Bot API answering `ok: false` is a refusal to report, not a success to assume.
func TestARefusalFromTelegramIsAnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":false,"description":"chat not found"}`))
	}))
	t.Cleanup(srv.Close)
	err := NewClient("t", srv.URL, 5*time.Second).Send(context.Background(), 1, "hi")
	if err == nil || !strings.Contains(err.Error(), "chat not found") {
		t.Fatalf("err = %v", err)
	}
}

// **The selectors, asserted against the values the chain carries.** The first version of this file
// had `accountFor` as `0x9c8b40c6`, typed from memory. A wrong selector on a contract with no
// fallback is a revert, which `accountOf` reports as "no account for that address" — a sentence a
// person would have believed. Read from Arbitrum One: `accountFor(0x3B4f…85F5)` on the deployed
// factory answers `0x0acdfa21a3cd075aee6583c8a8069f86ad3e4a39`.
func TestTheSelectorsAreTheOnesTheChainCarries(t *testing.T) {
	for _, c := range []struct{ name, got, want string }{
		{"accountFor(address)", selAccountFor, "0x7ce38c39"},
		{"balanceOf(address)", selBalanceOf, "0x70a08231"},
	} {
		if c.got != c.want {
			t.Errorf("%s is %s, want %s", c.name, c.got, c.want)
		}
	}
}

// A word of calldata is sixty-four hex characters whatever the address's case, and a balance is
// read as an integer rather than a float.
func TestCalldataAndDecoding(t *testing.T) {
	if p := padded("0x3B4f0135465d444a5bD06Ab90fC59B73916C85F5"); len(p) != 64 ||
		p != "0000000000000000000000003b4f0135465d444a5bd06ab90fc59b73916c85f5" {
		t.Errorf("padded = %q (%d)", p, len(p))
	}
	if a := wordToAddress("0x0000000000000000000000000acdfa21a3cd075aee6583c8a8069f86ad3e4a39"); a != "0x0acdfa21a3cd075aee6583c8a8069f86ad3e4a39" {
		t.Errorf("address = %q", a)
	}
	// The live account's idle balance, as the chain returns it.
	if v, err := wordToUint("0x0000000000000000000000000000000000000000000000000000000000002710"); err != nil || v != 10_000 {
		t.Errorf("v = %d, err = %v", v, err)
	}
	// Empty rather than an error: a call that returned nothing is zero, not a failure to parse.
	if v, err := wordToUint(""); err != nil || v != 0 {
		t.Errorf("v = %d, err = %v", v, err)
	}
	// **Refused rather than wrapped.** A balance past uint64 would otherwise come out small and
	// plausible, which is the worst possible answer.
	if _, err := wordToUint("0x" + strings.Repeat("f", 64)); err == nil {
		t.Error("a balance that does not fit was accepted")
	}
}

// A pruned node answers "missing trie node" with HTTP 200. A helper that dropped that would report
// an account holding nothing instead of an endpoint that cannot answer, which `internal/activity`
// already learned once.
func TestTheJsonRpcErrorIsReturnedRatherThanDropped(t *testing.T) {
	rpc := NewRPC("http://node", func(_ context.Context, _ string, _ []byte) ([]byte, error) {
		return []byte(`{"jsonrpc":"2.0","id":1,"error":{"message":"missing trie node"}}`), nil
	})
	if _, err := rpc.Call(context.Background(), "0xabc", "0xdef"); err == nil ||
		!strings.Contains(err.Error(), "missing trie node") {
		t.Fatalf("err = %v", err)
	}
}

// **The bot and the dapp must agree about one balance.** The portfolio page renders 1497196 as
// `1.50`; the first version of this truncated and rendered `1.49`. A person comparing the two had
// no way to tell which was lying.
func TestAFigureIsTheSameHereAsInTheApp(t *testing.T) {
	for _, c := range []struct {
		base uint64
		want string
	}{
		{1_497_196, "1.50"},
		{10_000, "0.01"},
		{490_081, "0.49"},
		{500_081, "0.50"},
		{0, "0.00"},
		{1_000_000, "1.00"},
		// Half away from zero, like toLocaleString on the other side.
		{1_005_000, "1.01"},
		{999_999, "1.00"},
	} {
		if got := usdc(c.base); got != c.want {
			t.Errorf("usdc(%d) = %s, want %s", c.base, got, c.want)
		}
	}
}
