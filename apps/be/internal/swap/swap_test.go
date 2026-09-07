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
	got, err := build(draft{Chain: "arbitrum", TokenIn: "eth", TokenOut: "usd coin", Amount: "0.5"})
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
			_, err := build(c.d)
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
	_, err := build(draft{TokenIn: "ETH", TokenOut: "USDC", Amount: "0,5"})
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
	_, err := c.ask(context.Background(), "swap 1 ETH into USDC")
	if err == nil || !strings.Contains(err.Error(), "refused") {
		t.Fatalf("err = %v, want the status reported", err)
	}
}

func TestBuildNamesWhatIsMissing(t *testing.T) {
	_, err := build(draft{TokenIn: "ETH"})
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
