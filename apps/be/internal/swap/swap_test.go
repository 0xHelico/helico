package swap

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestBaseUnits(t *testing.T) {
	cases := []struct {
		amount   string
		decimals int
		want     string
		wantErr  bool
	}{
		{"0.5", 18, "500000000000000000", false},
		{"1", 18, "1000000000000000000", false},
		{"1.5", 6, "1500000", false},
		{"0.000001", 6, "1", false},
		{"2.", 18, "2000000000000000000", false},
		{".25", 18, "250000000000000000", false},
		{"0.0000001", 6, "", true}, // more decimals than the token has
		{"0", 18, "", true},
		{"0.0", 18, "", true},
		{"-1", 18, "", true},
		{"one", 18, "", true},
		{"", 18, "", true},
		{"1e18", 18, "", true},
		// A comma is refused rather than read: "0,5" is half in Indonesian and five if the comma
		// is taken for a thousands separator, and the wrong reading is a ten-times swap.
		{"0,5", 18, "", true},
		{"1,5", 18, "", true},
		{"1,000.25", 6, "", true},
	}
	for _, c := range cases {
		got, err := baseUnits(c.amount, c.decimals)
		if c.wantErr {
			if err == nil {
				t.Errorf("baseUnits(%q, %d) = %s, want an error", c.amount, c.decimals, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("baseUnits(%q, %d): %v", c.amount, c.decimals, err)
			continue
		}
		if got.String() != c.want {
			t.Errorf("baseUnits(%q, %d) = %s, want %s", c.amount, c.decimals, got, c.want)
		}
	}
}

func TestBuildAcceptsWhatTheRegistryKnows(t *testing.T) {
	got, _, err := build(draft{Chain: "arbitrum", TokenIn: "eth", TokenOut: "usd coin", Amount: "0.5"})
	if err != nil {
		t.Fatal(err)
	}
	if got.ChainID != 42161 || got.TokenIn.Symbol != "ETH" || got.TokenOut.Symbol != "USDC" {
		t.Fatalf("resolved to %+v", got)
	}
	if got.AmountInWei != "500000000000000000" {
		t.Fatalf("amount in base units = %s", got.AmountInWei)
	}
	if got.TokenOut.Address != "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" {
		t.Fatalf("the address did not come from the registry: %s", got.TokenOut.Address)
	}
}

func TestBuildRefusesWhatItCannotCheck(t *testing.T) {
	cases := []struct {
		name    string
		d       draft
		wantSub string
	}{
		{"unknown token", draft{TokenIn: "ETH", TokenOut: "MOONCOIN", Amount: "1"}, "not a token I know"},
		{"an address instead of a symbol", draft{TokenIn: "ETH", TokenOut: "0x1234567890123456789012345678901234567890", Amount: "1"}, "not a token I know"},
		{"same token", draft{TokenIn: "ETH", TokenOut: "eth", Amount: "1"}, "the same"},
		{"unknown chain", draft{Chain: "solana", TokenIn: "ETH", TokenOut: "USDC", Amount: "1"}, "Arbitrum One"},
		{"amount too precise", draft{TokenIn: "USDC", TokenOut: "ETH", Amount: "0.0000001"}, "decimal places"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, _, err := build(c.d)
			if err == nil {
				t.Fatal("want an error")
			}
			if !strings.Contains(err.Error(), c.wantSub) {
				t.Fatalf("error was %q, want it to mention %q", err, c.wantSub)
			}
		})
	}
}

func TestBuildNamesOnlyTheFieldThatFailed(t *testing.T) {
	// A bad amount should not tell a form that the tokens are wrong too.
	_, _, err := build(draft{TokenIn: "ETH", TokenOut: "USDC", Amount: "0,5"})
	if err == nil {
		t.Fatal("a comma should be refused")
	}
	if got := faulty(err); len(got) != 1 || got[0] != "amount" {
		t.Fatalf("faulty = %v, want [amount]", got)
	}
}

func TestLookupChainResolvesWhatItDocuments(t *testing.T) {
	for _, s := range []string{"", "arbitrum", "Arbitrum One", "42161"} {
		if c, ok := LookupChain(s); !ok || c.ChainID != 42161 {
			t.Errorf("LookupChain(%q) = %+v, %v", s, c, ok)
		}
	}
	if _, ok := LookupChain("solana"); ok {
		t.Error("an unknown chain resolved")
	}
}

func TestBridgedUSDCIsRefusedRatherThanSubstituted(t *testing.T) {
	// USDC.e is a different contract with its own pools, and it answers USDC to symbol() too.
	// Resolving the name to the native token would hand someone an asset they did not name.
	if tok, ok := arbitrum.Token("USDC.e"); ok {
		t.Fatalf("USDC.e resolved to %s at %s", tok.Symbol, tok.Address)
	}
}

func TestAskReportsAStatusRatherThanAShape(t *testing.T) {
	// A gateway answering 502 with an HTML page is a status to report.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte("<html>bad gateway</html>"))
	}))
	t.Cleanup(srv.Close)
	c := NewClient(srv.URL, "test-key", "test-model", 5*time.Second)
	_, err := c.ask(context.Background(), "swap 1 ETH into USDC", nil)
	if err == nil || !strings.Contains(err.Error(), "refused") {
		t.Fatalf("err = %v, want the status reported", err)
	}
}

func TestBuildNamesWhatIsMissing(t *testing.T) {
	_, _, err := build(draft{TokenIn: "ETH"})
	var needs *ErrNeeds
	if !errors.As(err, &needs) {
		t.Fatalf("err = %v, want ErrNeeds", err)
	}
	if len(needs.Fields) != 2 || needs.Fields[0] != "tokenOut" || needs.Fields[1] != "amount" {
		t.Fatalf("needs = %v", needs.Fields)
	}
}

// fakeModel serves the OpenAI-compatible shape, answering with whatever content is given.
func fakeModel(t *testing.T, status int, content string) *Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" {
			t.Errorf("called %s, want /chat/completions", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer test-key" {
			t.Errorf("authorization was %q", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		body := map[string]any{"choices": []map[string]any{{"message": map[string]string{"role": "assistant", "content": content}}}}
		if status != http.StatusOK {
			body = map[string]any{"error": map[string]string{"message": content}}
		}
		_ = json.NewEncoder(w).Encode(body)
	}))
	t.Cleanup(srv.Close)
	return NewClient(srv.URL, "test-key", "test-model", 5*time.Second)
}

func TestInterpretComposesItsOwnConfirmation(t *testing.T) {
	svc := New(fakeModel(t, http.StatusOK, `{"chain":"arbitrum","tokenIn":"ETH","tokenOut":"USDC","amount":"0.5","question":""}`))
	got, err := svc.Interpret(context.Background(), "swap half an ETH into USDC")
	if err != nil {
		t.Fatal(err)
	}
	if got.Intent == nil {
		t.Fatalf("no intent: %+v", got)
	}
	if !strings.Contains(got.Reply, "0.5 ETH into USDC") || !strings.Contains(got.Reply, "Nothing has moved") {
		t.Fatalf("reply = %q", got.Reply)
	}
}

func TestInterpretAsksWhenSomethingIsMissing(t *testing.T) {
	svc := New(fakeModel(t, http.StatusOK, `{"tokenIn":"ETH","tokenOut":"USDC","amount":"","question":"How much ETH?"}`))
	got, err := svc.Interpret(context.Background(), "swap some ETH into USDC")
	if err != nil {
		t.Fatal(err)
	}
	if got.Intent != nil {
		t.Fatalf("built an intent from an empty amount: %+v", got.Intent)
	}
	if got.Reply != "How much ETH?" || len(got.Needs) != 1 || got.Needs[0] != "amount" {
		t.Fatalf("answer = %+v", got)
	}
}

func TestInterpretRefusesAModelsInvention(t *testing.T) {
	// The model names a token the registry does not have. The person gets told, and no intent
	// is built, which is the whole safety property of this package.
	svc := New(fakeModel(t, http.StatusOK, `{"tokenIn":"ETH","tokenOut":"MOONCOIN","amount":"1","question":""}`))
	got, err := svc.Interpret(context.Background(), "swap 1 ETH into mooncoin")
	if err != nil {
		t.Fatal(err)
	}
	if got.Intent != nil {
		t.Fatal("an unknown token produced an intent")
	}
	if !strings.Contains(got.Reply, "not a token I know") {
		t.Fatalf("reply = %q", got.Reply)
	}
}

func TestInterpretSurfacesAModelThatMisbehaves(t *testing.T) {
	for _, c := range []struct {
		name, content string
		status        int
	}{
		{"not JSON at all", "I think you want to swap!", http.StatusOK},
		{"an error from the provider", "insufficient quota", http.StatusTooManyRequests},
	} {
		t.Run(c.name, func(t *testing.T) {
			svc := New(fakeModel(t, c.status, c.content))
			if _, err := svc.Interpret(context.Background(), "swap 1 ETH into USDC"); err == nil {
				t.Fatal("want an error rather than a guess")
			}
		})
	}
}

func TestInterpretWithoutAKey(t *testing.T) {
	svc := New(NewClient("", "", "", 0))
	if _, err := svc.Interpret(context.Background(), "swap 1 ETH into USDC"); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("err = %v, want ErrNotConfigured", err)
	}
}

func TestInterpretBoundsTheMessage(t *testing.T) {
	svc := New(fakeModel(t, http.StatusOK, `{}`))
	if _, err := svc.Interpret(context.Background(), ""); err == nil {
		t.Fatal("want an error for an empty message")
	}
	if _, err := svc.Interpret(context.Background(), strings.Repeat("a", maxMessage+1)); err == nil {
		t.Fatal("want an error for a long message")
	}
}

// The conversation reaches five things now, and which one it reached is decided here rather
// than in the browser. These are the answers the app switches its screen on.
func TestInterpretReachesTheActionsTheAppAlreadyDoes(t *testing.T) {
	cases := []struct {
		name       string
		content    string
		wantAction string
		wantIntent bool
	}{
		{
			name:       "revoking the mandate needs no parameters and gets no intent",
			content:    `{"action":"revoke","chain":"","tokenIn":"","tokenOut":"","amount":"","question":""}`,
			wantAction: ActionRevoke,
		},
		{
			name:       "asking for the money back reaches the escape hatch, not the revoke screen",
			content:    `{"action":"withdraw","chain":"","tokenIn":"","tokenOut":"","amount":"","question":""}`,
			wantAction: ActionWithdraw,
		},
		{
			name:       "a greeting is answered by the application, not by the model",
			content:    `{"action":"about","chain":"","tokenIn":"","tokenOut":"","amount":"","question":"What can I help you with?"}`,
			wantAction: ActionAbout,
		},
		{
			name:       "asking about the position is the same shape",
			content:    `{"action":"status","chain":"","tokenIn":"","tokenOut":"","amount":"","question":""}`,
			wantAction: ActionStatus,
		},
		{
			name:       "a swap still goes through the registry and comes back with one",
			content:    `{"action":"swap","chain":"arbitrum","tokenIn":"ETH","tokenOut":"USDC","amount":"0.5","question":""}`,
			wantAction: ActionSwap,
			wantIntent: true,
		},
		{
			// Anything the model does not label is a swap, which keeps every earlier reply valid
			// and keeps the common case the default.
			name:       "no action at all is read as a swap",
			content:    `{"chain":"arbitrum","tokenIn":"ETH","tokenOut":"USDC","amount":"1","question":""}`,
			wantAction: ActionSwap,
			wantIntent: true,
		},
		{
			// A model that invents an action must not reach a screen. Falling through to the swap
			// path means it is checked by build and refused there, rather than switched on.
			name:       "an invented action does not reach a screen of its own",
			content:    `{"action":"drain","chain":"arbitrum","tokenIn":"","tokenOut":"","amount":"","question":""}`,
			wantAction: ActionSwap,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := New(fakeModel(t, 200, c.content)).Interpret(context.Background(), "do the thing")
			if err != nil {
				t.Fatal(err)
			}
			if got.Action != c.wantAction {
				t.Fatalf("action = %q, want %q", got.Action, c.wantAction)
			}
			if (got.Intent != nil) != c.wantIntent {
				t.Fatalf("intent present = %v, want %v", got.Intent != nil, c.wantIntent)
			}
			if strings.TrimSpace(got.Reply) == "" {
				t.Fatal("every answer needs a sentence a person can read")
			}
		})
	}
}

// The two parameterless actions must not be able to carry a token or an amount out of the model.
// Nothing downstream reads them for these actions today, and this is what keeps that true.
func TestAParameterlessActionCarriesNoIntent(t *testing.T) {
	for _, action := range []string{ActionRevoke, ActionStatus, ActionAbout, ActionWithdraw} {
		t.Run(action, func(t *testing.T) {
			content := `{"action":"` + action + `","chain":"arbitrum","tokenIn":"ETH","tokenOut":"USDC","amount":"999999","question":""}`
			got, err := New(fakeModel(t, 200, content)).Interpret(context.Background(), "stop it")
			if err != nil {
				t.Fatal(err)
			}
			if got.Intent != nil {
				t.Fatalf("%s came back carrying an intent for %s %s", action, got.Intent.AmountIn, got.Intent.TokenIn.Symbol)
			}
			if len(got.Needs) != 0 {
				t.Fatalf("%s asked for %v, and needs nothing", action, got.Needs)
			}
		})
	}
}

// The reply to "what can you do" is composed here rather than by the model, so it can only ever
// offer what this package implements. The check is that it names the registry rather than a list
// written beside it — a second list is the one that goes stale.
func TestAboutOffersOnlyWhatTheRegistryHolds(t *testing.T) {
	got, err := New(fakeModel(t, 200, `{"action":"about","question":"What can I help you with?"}`)).
		Interpret(context.Background(), "apa yang bisa kamu lakukan")
	if err != nil {
		t.Fatal(err)
	}
	// The model's own question must not be what the person reads: it is the sentence that made
	// this necessary in the first place.
	if strings.Contains(got.Reply, "What can I help you with?") {
		t.Fatalf("the model wrote the reply: %q", got.Reply)
	}
	for _, symbol := range arbitrum.Symbols() {
		if !strings.Contains(got.Reply, symbol) {
			t.Errorf("the reply does not offer %s, which the registry holds", symbol)
		}
	}
	// A capability we do not have may be *named*, and must never be *offered*. Naming it is the
	// point: somebody who asks "can you provide liquidity?" and gets four bullets that do not
	// mention it reads that as evasion rather than as a no. So the check is where the word falls,
	// not whether it appears — everything before "Not yet" is a thing Helico does.
	offered, refused, split := strings.Cut(got.Reply, "Not yet")
	if !split {
		t.Fatal("the reply names nothing it cannot do, so a question about one gets silence")
	}
	for _, word := range []string{"bridge", "borrow", "perpetual", "liquidity as a maker"} {
		if strings.Contains(strings.ToLower(offered), word) {
			t.Errorf("%q is offered, and no action behind it does that", word)
		}
	}
	// And the ones it does refuse have to be there, or the paragraph is decoration.
	for _, word := range []string{"liquidity as a maker", "borrowing"} {
		if !strings.Contains(strings.ToLower(refused), word) {
			t.Errorf("the reply does not say it cannot do %q", word)
		}
	}
}

// The tree is the checks that ran, so a refusal has to end on the check that refused. A list
// assembled from the outcome could name a step that never executed, which is the failure this
// test exists to catch.
func TestStepsAreTheChecksThatActuallyRan(t *testing.T) {
	cases := []struct {
		name      string
		content   string
		wantCalls []string
		wantLast  bool
	}{
		{
			name:      "a swap that works records every check",
			content:   `{"action":"swap","chain":"arbitrum","tokenIn":"ETH","tokenOut":"USDC","amount":"0.5"}`,
			wantCalls: []string{"Client.ask", "LookupChain", "Chain.Token", "Chain.Token", "baseUnits"},
			wantLast:  true,
		},
		{
			name:      "an unknown token stops at the lookup that refused it",
			content:   `{"action":"swap","chain":"arbitrum","tokenIn":"ETH","tokenOut":"MOONCOIN","amount":"1"}`,
			wantCalls: []string{"Client.ask", "LookupChain", "Chain.Token", "Chain.Token"},
		},
		{
			name:      "a bad amount reaches baseUnits and no further",
			content:   `{"action":"swap","chain":"arbitrum","tokenIn":"ETH","tokenOut":"USDC","amount":"0,5"}`,
			wantCalls: []string{"Client.ask", "LookupChain", "Chain.Token", "Chain.Token", "baseUnits"},
		},
		{
			name:      "an action with no parameters runs one check, because one is all there is",
			content:   `{"action":"revoke"}`,
			wantCalls: []string{"Client.ask"},
			wantLast:  true,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := New(fakeModel(t, 200, c.content)).Interpret(context.Background(), "do the thing")
			if err != nil {
				t.Fatal(err)
			}
			if len(got.Steps) != len(c.wantCalls) {
				t.Fatalf("steps = %+v, want %d of them", got.Steps, len(c.wantCalls))
			}
			for i, want := range c.wantCalls {
				if got.Steps[i].Call != want {
					t.Errorf("step %d is %q, want %q", i, got.Steps[i].Call, want)
				}
			}
			last := got.Steps[len(got.Steps)-1]
			if last.OK != c.wantLast {
				t.Errorf("the last step %q is ok=%v, want %v", last.Call, last.OK, c.wantLast)
			}
			for i, s := range got.Steps {
				if strings.TrimSpace(s.Detail) == "" {
					t.Errorf("step %d (%s) says nothing", i, s.Call)
				}
			}
		})
	}
}

// The address in a step comes from the registry, and it is the one thing in an intent a model
// could not have chosen. Showing a shortened one is only worth doing if it is that address.
func TestStepsCarryTheRegistrysAddress(t *testing.T) {
	got, err := New(fakeModel(t, 200, `{"action":"swap","chain":"arbitrum","tokenIn":"ETH","tokenOut":"USDC","amount":"0.5"}`)).
		Interpret(context.Background(), "swap it")
	if err != nil {
		t.Fatal(err)
	}
	usdc, _ := arbitrum.Token("USDC")
	head, tail := usdc.Address[:6], usdc.Address[len(usdc.Address)-4:]
	var found bool
	for _, s := range got.Steps {
		if s.Call == "Chain.Token" && strings.Contains(s.Detail, head) && strings.Contains(s.Detail, tail) {
			found = true
		}
	}
	if !found {
		t.Fatalf("no step carries %s…%s; steps were %+v", head, tail, got.Steps)
	}
}

// Revoking and withdrawing are the two halves of getting out, and answering one with the other is
// the failure this test exists for: until `withdraw` existed the app offered "Take everything back
// to my wallet" on its empty screen, the sentence had nowhere to go but `revoke`, and a person
// asking for their money was told the mandate had ended while every token stayed where it was.
func TestWithdrawAndRevokeAreNotEachOther(t *testing.T) {
	withdraw, err := New(fakeModel(t, 200, `{"action":"withdraw"}`)).Interpret(context.Background(), "take everything back to my wallet")
	if err != nil {
		t.Fatal(err)
	}
	revoke, err := New(fakeModel(t, 200, `{"action":"revoke"}`)).Interpret(context.Background(), "stop the agent")
	if err != nil {
		t.Fatal(err)
	}
	if withdraw.Action == revoke.Action {
		t.Fatal("the two reach the same screen")
	}
	if withdraw.Reply == revoke.Reply {
		t.Fatal("the two say the same thing")
	}
	// Each has to describe what it does, because the whole mistake is a person reading one and
	// believing the other happened.
	if !strings.Contains(strings.ToLower(withdraw.Reply), "back to you") {
		t.Errorf("withdraw does not say the money comes back: %q", withdraw.Reply)
	}
	if strings.Contains(strings.ToLower(revoke.Reply), "wallet") {
		t.Errorf("revoke talks about a wallet, and it moves nothing: %q", revoke.Reply)
	}
}

// The escape hatch's two properties are the reason it is safe to offer in a sentence, so the
// sentence has to carry them: there is one destination and it was fixed at construction, and the
// path lives somewhere an upgrade cannot reach.
func TestWithdrawNamesWhatMakesItSafe(t *testing.T) {
	got, err := New(fakeModel(t, 200, `{"action":"withdraw"}`)).Interpret(context.Background(), "get me out")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"no recipient", "nowhere else", "proxy", "receipt"} {
		if !strings.Contains(strings.ToLower(got.Reply), want) {
			t.Errorf("the reply does not mention %q: %q", want, got.Reply)
		}
	}
}

// Prior turns exist so that "make it two instead" has something to be about. They reach the model
// and they reach nothing else: the registry still decides what a token is, so an earlier turn can
// help fill a field and cannot help invent one.
func TestPriorTurnsReachTheModelAndNothingElse(t *testing.T) {
	var seen []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Messages []map[string]any `json:"messages"`
		}
		_ = json.NewDecoder(r.Body).Decode(&in)
		seen = in.Messages
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []map[string]any{
			{"message": map[string]string{"role": "assistant", "content": `{"action":"swap","chain":"arbitrum","tokenIn":"ETH","tokenOut":"USDC","amount":"2"}`}},
		}})
	}))
	t.Cleanup(srv.Close)

	svc := New(NewClient(srv.URL, "test-key", "test-model", 5*time.Second))
	got, err := svc.Interpret(context.Background(), "make it two instead",
		Turn{Role: "user", Body: "swap 1 ETH into USDC"},
		Turn{Role: "assistant", Body: "Swapping 1 ETH into USDC on Arbitrum One."},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(seen) != 4 {
		t.Fatalf("the model saw %d messages, want system + two prior + the new one", len(seen))
	}
	if seen[0]["role"] != "system" || seen[3]["content"] != "make it two instead" {
		t.Fatalf("the shape is wrong: %+v", seen)
	}
	if got.Intent == nil || got.Intent.AmountIn != "2" {
		t.Fatalf("the answer did not carry the amount: %+v", got.Intent)
	}
}

// A caller cannot make this endpoint hold a transcript, and an earlier turn cannot be a novel.
func TestPriorTurnsAreBounded(t *testing.T) {
	var seen int
	var longest int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Messages []struct{ Content string } `json:"messages"`
		}
		_ = json.NewDecoder(r.Body).Decode(&in)
		seen = len(in.Messages)
		for _, m := range in.Messages[1 : len(in.Messages)-1] {
			if n := utf8.RuneCountInString(m.Content); n > longest {
				longest = n
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []map[string]any{
			{"message": map[string]string{"role": "assistant", "content": `{"action":"status"}`}},
		}})
	}))
	t.Cleanup(srv.Close)

	prior := make([]Turn, 40)
	for i := range prior {
		prior[i] = Turn{Role: "user", Body: strings.Repeat("x", 5_000)}
	}
	if _, err := New(NewClient(srv.URL, "test-key", "m", 5*time.Second)).
		Interpret(context.Background(), "status", prior...); err != nil {
		t.Fatal(err)
	}
	if seen != maxPrior+2 {
		t.Errorf("the model saw %d messages, want %d", seen, maxPrior+2)
	}
	if longest != maxPriorRunes {
		t.Errorf("an earlier turn reached the model at %d runes, want %d", longest, maxPriorRunes)
	}
}
