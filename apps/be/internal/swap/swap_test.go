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
	c := NewClient(5*time.Second, Upstream{BaseURL: srv.URL, Key: "test-key", Model: "test-model"})
	_, _, err := c.ask(context.Background(), "swap 1 ETH into USDC", nil)
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
	return NewClient(5*time.Second, Upstream{BaseURL: srv.URL, Key: "test-key", Model: "test-model"})
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
	svc := New(NewClient(0))
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
			content:    `{"action":"drain","chain":"arbitrum","tokenIn":"ETH","tokenOut":"USDC","amount":"1","question":""}`,
			wantAction: ActionSwap,
			wantIntent: true,
		},
		{
			// The same invention with nothing in it reaches the help text rather than a demand for
			// three fields. Either way the word the model made up buys it nothing.
			name:       "an invented action with an empty draft reaches the help text",
			content:    `{"action":"drain","chain":"arbitrum","tokenIn":"","tokenOut":"","amount":"","question":""}`,
			wantAction: ActionAbout,
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
	// The four things it can do are cards now rather than bullets, and the registry's symbols are
	// tags on the swap one. So the offer is the reply plus the cards, and that is what the checks
	// below read: a symbol that reached neither is a token the chat holds and never mentions.
	if len(got.Cards) == 0 {
		t.Fatal("the answer carries no cards, so the app has a wall of text to draw")
	}
	//
	// The cards go in front of the reply on purpose. The split below is on "Not yet", which lives
	// at the end of the reply, so anything appended after it lands in the half where a refused
	// capability is allowed to be named — and the cards are exactly the half that must not offer
	// one.
	var offers strings.Builder
	for _, c := range got.Cards {
		if c.Title == "" || c.Body == "" {
			t.Errorf("card %+v has nothing to draw", c)
		}
		// Pressable or it is a bullet with a border. One of the two ways, never both: a card that
		// both sends a sentence and navigates has two things to do and one place to press.
		if (c.Try == "") == (c.Href == "") {
			t.Errorf("card %q offers %q to send and %q to open; it needs exactly one", c.Title, c.Try, c.Href)
		}
		offers.WriteString(c.Title + " " + c.Body + " " + c.Try + " " + strings.Join(c.Tags, " ") + " ")
	}
	offers.WriteString(got.Reply)
	for _, symbol := range arbitrum.Symbols() {
		if !strings.Contains(offers.String(), symbol) {
			t.Errorf("nothing offers %s, which the registry holds", symbol)
		}
	}

	// Earning is the product, and it survived as a clause in a paragraph until #330 while six cards
	// described everything around it. Naming the three protocols here is what stops the card being
	// quietly reduced to "a lending market" again, which is what it said when there was one.
	for _, named := range []string{"Earn", "Aave", "Compound", "Morpho"} {
		if !strings.Contains(offers.String(), named) {
			t.Errorf("the answer never mentions %q, and that is what this product does", named)
		}
	}
	// A capability we do not have may be *named*, and must never be *offered*. Naming it is the
	// point: somebody who asks "can you provide liquidity?" and gets four bullets that do not
	// mention it reads that as evasion rather than as a no. So the check is where the word falls,
	// not whether it appears — everything before "Not yet" is a thing Helico does.
	offered, refused, split := strings.Cut(offers.String(), "Not yet")
	if !split {
		t.Fatal("the reply names nothing it cannot do, so a question about one gets silence")
	}
	// `staking` is on this list because it was asked for and does not exist: nothing in
	// `contracts/src`, `apps` or `packages` stakes anything, so a card offering it would be a
	// partner integration that is not there — the category the rules disqualify rather than deduct.
	// "liquidity as a maker" left this list when it stopped being a thing we cannot do: `provide`
	// ships a position through Aqua, and `shipCall` is reached from the app rather than only from a
	// script. Naming it as a refusal after that would be the same failure in the other direction.
	for _, word := range []string{"bridge", "borrow", "perpetual", "staking", "stake "} {
		if strings.Contains(strings.ToLower(offered), word) {
			t.Errorf("%q is offered, and no action behind it does that", word)
		}
	}
	// And the ones it does refuse have to be there, or the paragraph is decoration.
	for _, word := range []string{"borrowing", "more than one market"} {
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

	svc := New(NewClient(5*time.Second, Upstream{BaseURL: srv.URL, Key: "test-key", Model: "test-model"}))
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
	if _, err := New(NewClient(5*time.Second, Upstream{BaseURL: srv.URL, Key: "test-key", Model: "m"})).
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

// TestEarnIsItsOwnAction holds the line the Earn card is built on: a person asking to start
// earning gets `earn`, not `about`, and the answer names the three things that have to be true
// without pretending this endpoint can do any of them.
//
// Before it existed, "put my idle USDC to work" fell through to `about`, which described earning
// to somebody who was trying to begin it — and the card it produced was a link to a page where
// they still had to find the control.
func TestEarnIsItsOwnAction(t *testing.T) {
	svc := New(fakeModel(t, http.StatusOK, `{"action":"earn","chain":"arbitrum","tokenIn":"","tokenOut":"","amount":"","question":""}`))
	got, err := svc.Interpret(context.Background(), "put my idle USDC to work")
	if err != nil {
		t.Fatal(err)
	}
	if got.Action != ActionEarn {
		t.Fatalf("action = %q, want %q", got.Action, ActionEarn)
	}
	if got.Intent != nil {
		t.Fatalf("earn built a swap intent: %+v", got.Intent)
	}
	// The three conditions, in the order they have to happen in. A reply that named only the
	// markets would send someone to enable a venue for an account holding nothing.
	// The three conditions, in the order they have to happen in. Worded shorter than they were —
	// the reply is read while deciding what to press, not studied — so the check names the verbs
	// rather than the sentences, which is the part that must survive a rewrite.
	for _, want := range []string{"name the agent", "allow the market", "put the money in"} {
		if !strings.Contains(got.Reply, want) {
			t.Errorf("reply does not name %q: %q", want, got.Reply)
		}
	}
}

// TestEarnCanSwapFirst is the one-sentence, one-signature case: "swap $1 of ETH to USDC and put
// it all to work". The action stays earn — the card is the put-to-work card — and the swap half
// is built and checked exactly as a swap would be, so the intent beside it is a registry-checked
// ETH → USDC for one dollar, not the model's words.
func TestEarnCanSwapFirst(t *testing.T) {
	svc := New(fakeModel(t, http.StatusOK, `{"action":"earn","chain":"arbitrum","tokenIn":"ETH","tokenOut":"USDC","amount":"","amountUsd":"1","question":""}`))
	got, err := svc.Interpret(context.Background(), "swap $1 of ETH to USDC and put it all to work")
	if err != nil {
		t.Fatal(err)
	}
	if got.Action != ActionEarn {
		t.Fatalf("action = %q, want %q", got.Action, ActionEarn)
	}
	if got.Intent == nil || got.Intent.TokenIn.Symbol != "ETH" || got.Intent.TokenOut.Symbol != "USDC" || got.Intent.AmountUsd != "1" {
		t.Fatalf("the swap half was not built: %+v", got.Intent)
	}
	if !strings.Contains(got.Reply, "one signature") || !strings.Contains(got.Reply, "$1 of ETH") {
		t.Errorf("reply does not say what it does: %q", got.Reply)
	}

	// tokenOut left empty is USDC — that is the only thing the account puts to work.
	svc = New(fakeModel(t, http.StatusOK, `{"action":"earn","chain":"arbitrum","tokenIn":"ETH","tokenOut":"","amount":"0.001","amountUsd":"","question":""}`))
	got, err = svc.Interpret(context.Background(), "swap 0.001 ETH and put it to work")
	if err != nil {
		t.Fatal(err)
	}
	if got.Intent == nil || got.Intent.TokenOut.Symbol != "USDC" {
		t.Fatalf("an empty tokenOut did not default to USDC: %+v", got.Intent)
	}

	// A swap that ends anywhere but USDC is refused by name, and the action is still earn so the
	// person is not bounced to a swap card they did not ask for.
	svc = New(fakeModel(t, http.StatusOK, `{"action":"earn","chain":"arbitrum","tokenIn":"USDC","tokenOut":"WETH","amount":"5","amountUsd":"","question":""}`))
	got, err = svc.Interpret(context.Background(), "swap 5 USDC to WETH and put it to work")
	if err != nil {
		t.Fatal(err)
	}
	if got.Action != ActionEarn || got.Intent != nil || len(got.Needs) != 1 || got.Needs[0] != "tokenOut" {
		t.Fatalf("a non-USDC funding swap was not refused: action=%q intent=%+v needs=%v", got.Action, got.Intent, got.Needs)
	}
}

// TestEarnCardIsPressable keeps the Earn card from going back to being a link. Every card carries
// exactly one of Try or Href, and the whole point of #387 is that this one is a sentence a person
// can send rather than a page they have to go and read.
func TestEarnCardIsPressable(t *testing.T) {
	_, cards := about()
	for _, c := range cards {
		if c.Title != "Earn" {
			continue
		}
		if c.Try == "" || c.Href != "" {
			t.Fatalf("Earn card = %+v, want a Try and no Href", c)
		}
		return
	}
	t.Fatal("no Earn card")
}

// TestDepositIsItsOwnAction holds the line between paying yourself and trading.
//
// "Move 50 USDC into my account" and "Swap 50 USDC into WETH" are one word apart and mean opposite
// things: a transfer to a contract the person owns, and an exchange between two tokens. The second
// spends money at a price; the first does not. A classifier that confuses them turns a deposit into
// a swap card quoting a pair nobody asked about.
func TestDepositIsItsOwnAction(t *testing.T) {
	svc := New(fakeModel(t, http.StatusOK, `{"action":"deposit","chain":"arbitrum","tokenIn":"","tokenOut":"","amount":"","question":""}`))
	got, err := svc.Interpret(context.Background(), "move 50 USDC into my account")
	if err != nil {
		t.Fatal(err)
	}
	if got.Action != ActionDeposit {
		t.Fatalf("action = %q, want %q", got.Action, ActionDeposit)
	}
	if got.Intent != nil {
		t.Fatalf("deposit built a swap intent: %+v", got.Intent)
	}
	// The two things a person needs to know before they sign: that it is theirs, and that nothing
	// is being granted. Neither is decoration — an approval is what this deliberately is not.
	for _, want := range []string{"only you own", "no approval"} {
		if !strings.Contains(got.Reply, want) {
			t.Errorf("reply does not say %q: %q", want, got.Reply)
		}
	}
}

// TestMoneyInIsACardYouCanSend keeps Money in reachable from the one screen it now lives on.
// It was a panel on the limits page; moving it into the conversation only works if the
// conversation says it exists.
func TestMoneyInIsACardYouCanSend(t *testing.T) {
	_, cards := about()
	for _, c := range cards {
		if c.Title != "Money in" {
			continue
		}
		if c.Try == "" || c.Href != "" {
			t.Fatalf("Money in card = %+v, want a Try and no Href", c)
		}
		return
	}
	t.Fatal("no Money in card")
}

// TestDollarsAreNotConvertedHere is the line that keeps an unverifiable number out of a signature.
//
// A person who says "$5 of ETH" is asking for a token amount this package cannot compute: it has
// no price, and a model asked to divide by a rate produces a figure nobody can check. So the
// intent carries the dollars, `amountInWei` stays empty, and the wallet fills it in from its own
// Chainlink read. The confirmation says "$5 of ETH" rather than naming a token figure with no
// source behind it.
func TestDollarsAreNotConvertedHere(t *testing.T) {
	svc := New(fakeModel(t, http.StatusOK, `{"action":"swap","chain":"arbitrum","tokenIn":"ETH","tokenOut":"USDC","amount":"","amountUsd":"5","question":""}`))
	got, err := svc.Interpret(context.Background(), "swap $5 ETH to USDC")
	if err != nil {
		t.Fatal(err)
	}
	if got.Intent == nil {
		t.Fatalf("no intent: %+v", got)
	}
	if got.Intent.AmountUsd != "5" {
		t.Errorf("amountUsd = %q, want 5", got.Intent.AmountUsd)
	}
	if got.Intent.AmountInWei != "" {
		t.Errorf("a price was invented here: amountInWei = %q", got.Intent.AmountInWei)
	}
	if !strings.Contains(got.Reply, "$5 of ETH") {
		t.Errorf("the reply names a token figure it did not compute: %q", got.Reply)
	}
}

// TestADollarAmountStillHasToBeANumber keeps the one check that belongs here. The conversion is
// the wallet's, but "$abc" must not reach it: a figure that is not a number would be divided by a
// price and become one.
func TestADollarAmountStillHasToBeANumber(t *testing.T) {
	svc := New(fakeModel(t, http.StatusOK, `{"action":"swap","chain":"arbitrum","tokenIn":"ETH","tokenOut":"USDC","amount":"","amountUsd":"abc","question":""}`))
	got, err := svc.Interpret(context.Background(), "swap $abc ETH to USDC")
	if err == nil && got.Intent != nil {
		t.Fatalf("built an intent from a dollar amount that is not a number: %+v", got.Intent)
	}
}

// TestTheModelIsShownEveryFieldItIsToldToFill is the check that would have saved a live bug.
//
// The prompt's rules told the model to use `amountUsd`, and the JSON shape it was shown did not
// have the field. So it answered in the shape it was given, the dollars went into `question`, and
// production replied "5" and asked for an amount — for the sentence that is a starter button on
// the front door.
//
// The fork suite could not catch it: that one classifier response is stubbed, because the field
// ships in the same change as the code that reads it. A stub is an honest way to test everything
// downstream of the model and no way at all to test the model's instructions, and this is the
// cheapest thing that does.
func TestTheModelIsShownEveryFieldItIsToldToFill(t *testing.T) {
	shape := ""
	for _, line := range strings.Split(systemPrompt, "\n") {
		if strings.HasPrefix(line, `{"action"`) {
			shape = line
			break
		}
	}
	if shape == "" {
		t.Fatal("the prompt no longer shows the model a JSON shape; this test cannot do its job")
	}
	for _, field := range []string{"action", "chain", "tokenIn", "tokenOut", "amount", "amountUsd", "question"} {
		if !strings.Contains(shape, `"`+field+`"`) {
			t.Errorf("the prompt names %q in its rules and not in the shape it shows: %s", field, shape)
		}
	}
}
