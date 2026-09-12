package swap

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// answering is a stub upstream that records what it was sent.
type answering struct {
	srv     *httptest.Server
	calls   int
	auth    string
	apiKey  string
	rawURL  string
	body    map[string]any
	status  int
	content string
}

func stub(t *testing.T, status int, content string) *answering {
	t.Helper()
	a := &answering{status: status, content: content}
	a.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a.calls++
		a.auth = r.Header.Get("Authorization")
		a.apiKey = r.Header.Get("X-Api-Key")
		a.rawURL = r.URL.String()
		_ = json.NewDecoder(r.Body).Decode(&a.body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(a.status)
		if a.status != http.StatusOK {
			_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"message": a.content}})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{"message": map[string]string{"role": "assistant", "content": a.content}}},
		})
	}))
	t.Cleanup(a.srv.Close)
	return a
}

const reply = `{"action":"status","chain":"arbitrum","tokenIn":"","tokenOut":"","amount":"","amountUsd":"","question":""}`

// **A router being down is a reason to ask the other one.** The two configured here are separate
// machines belonging to separate people, and the conversation going off because the first one is
// unreachable is exactly the failure a second entry exists to prevent.
func TestADeadUpstreamFallsThroughToTheNextOne(t *testing.T) {
	dead := stub(t, http.StatusBadGateway, "upstream is down")
	alive := stub(t, http.StatusOK, reply)
	c := NewClient(5*time.Second,
		Upstream{BaseURL: dead.srv.URL, Key: "one", Model: "a/fast"},
		Upstream{BaseURL: alive.srv.URL, Key: "two", Model: "b/slow"},
	)
	got, err := c.ask(context.Background(), "why has nothing moved?", nil)
	if err != nil {
		t.Fatalf("the fallback did not answer: %v", err)
	}
	if got.Action != "status" {
		t.Errorf("action %q", got.Action)
	}
	if dead.calls != 1 || alive.calls != 1 {
		t.Errorf("calls: dead %d, alive %d", dead.calls, alive.calls)
	}
	// And the model actually asked is the one that answered, not the first one's name.
	if alive.body["model"] != "b/slow" {
		t.Errorf("asked for %v", alive.body["model"])
	}
}

// The fallback costs money too, so it is only reached when the first one fails.
func TestAWorkingUpstreamNeverReachesTheFallback(t *testing.T) {
	first := stub(t, http.StatusOK, reply)
	second := stub(t, http.StatusOK, reply)
	c := NewClient(5*time.Second,
		Upstream{BaseURL: first.srv.URL, Key: "one", Model: "a/fast"},
		Upstream{BaseURL: second.srv.URL, Key: "two", Model: "b/slow"},
	)
	if _, err := c.ask(context.Background(), "status", nil); err != nil {
		t.Fatal(err)
	}
	if first.calls != 1 || second.calls != 0 {
		t.Errorf("calls: first %d, second %d", first.calls, second.calls)
	}
}

// An entry with no key is a half-written configuration, not an upstream. Trying it would spend an
// attempt on a call that cannot succeed, and the error it produced would be the one reported.
func TestAnUpstreamWithNoKeyIsNotAnUpstream(t *testing.T) {
	alive := stub(t, http.StatusOK, reply)
	c := NewClient(5*time.Second,
		Upstream{BaseURL: "https://nowhere.invalid/v1", Key: "", Model: "a/fast"},
		Upstream{BaseURL: alive.srv.URL, Key: "two", Model: "b/slow"},
	)
	if len(c.ups) != 1 {
		t.Fatalf("kept %d upstreams", len(c.ups))
	}
	if _, err := c.ask(context.Background(), "status", nil); err != nil {
		t.Fatal(err)
	}
	if !c.Configured() {
		t.Error("one keyed upstream is configured")
	}
	if New(NewClient(0)).Configured() {
		t.Error("no keys at all is not configured")
	}
}

// **Basic credentials are a header, never the URL.** A request that never connects comes back as a
// `*url.Error`, which prints the URL it was given, so credentials in the userinfo end up in every
// log and error string that value reaches. One `Authorization` header cannot carry a Basic
// challenge and a Bearer token at once either, and the proxy in front answers first, so the key
// moves to `X-Api-Key`.
func TestBasicCredentialsTakeTheHeaderAndTheKeyMovesAside(t *testing.T) {
	proxied := stub(t, http.StatusOK, reply)
	c := NewClient(5*time.Second, Upstream{
		BaseURL: proxied.srv.URL,
		Key:     "router-key",
		Model:   "ag/some-agent",
		User:    "operator",
		Pass:    "a-password",
	})
	if _, err := c.ask(context.Background(), "status", nil); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(proxied.auth, "Basic ") {
		t.Errorf("authorization was %q, want the proxy's Basic challenge", proxied.auth)
	}
	if proxied.apiKey != "router-key" {
		t.Errorf("x-api-key was %q", proxied.apiKey)
	}
	// Neither credential may appear in the path or the query.
	for _, secret := range []string{"router-key", "a-password", "operator"} {
		if strings.Contains(proxied.rawURL, secret) {
			t.Errorf("a credential reached the URL: %s", proxied.rawURL)
		}
	}
	if strings.Contains(c.ups[0].BaseURL, "operator") {
		t.Error("the base URL carries userinfo")
	}
}

// Without basic credentials the ordinary arrangement, and no second copy of the key in a header
// this endpoint did not ask for.
func TestWithoutBasicCredentialsTheKeyIsABearerToken(t *testing.T) {
	plain := stub(t, http.StatusOK, reply)
	c := NewClient(5*time.Second, Upstream{BaseURL: plain.srv.URL, Key: "router-key", Model: "x/y"})
	if _, err := c.ask(context.Background(), "status", nil); err != nil {
		t.Fatal(err)
	}
	if plain.auth != "Bearer router-key" {
		t.Errorf("authorization was %q", plain.auth)
	}
	if plain.apiKey != "" {
		t.Errorf("x-api-key was sent to an endpoint that did not need it: %q", plain.apiKey)
	}
}

// **`stream: false` is sent explicitly.** It is the OpenAI default and not every router's: one of
// ours answers `text/event-stream` unless told otherwise, and a stream of `data:` chunks does not
// unmarshal into the response shape. Omitting it fails with a parse error about a shape, which
// says nothing about the cause.
func TestTheRequestAsksForOneObjectRatherThanAStream(t *testing.T) {
	s := stub(t, http.StatusOK, reply)
	c := NewClient(5*time.Second, Upstream{BaseURL: s.srv.URL, Key: "k", Model: "x/y"})
	if _, err := c.ask(context.Background(), "status", nil); err != nil {
		t.Fatal(err)
	}
	if s.body["stream"] != false {
		t.Errorf("stream was %v, want false to be stated", s.body["stream"])
	}
	format, _ := s.body["response_format"].(map[string]any)
	if format["type"] != "json_object" {
		t.Errorf("response_format was %v", s.body["response_format"])
	}
}

// A router's model string names the account the call is billed to. `/api/swap/config` publishes
// this, and the account is nobody's business even though it is not a credential.
func TestTheReportedModelIsTheFamilyNotTheRoutingString(t *testing.T) {
	for _, c := range []struct{ routing, want string }{
		{"fajar-openai/gpt-4o-mini", "gpt-4o-mini"},
		{"ag/gemini-pro-agent", "gemini-pro-agent"},
		{"gpt-4o-mini", "gpt-4o-mini"},
	} {
		got := NewClient(time.Second, Upstream{BaseURL: "https://x/v1", Key: "k", Model: c.routing}).Model()
		if got != c.want {
			t.Errorf("%s reported as %q, want %q", c.routing, got, c.want)
		}
	}
	if NewClient(time.Second).Model() != "" {
		t.Error("an unconfigured client names no model")
	}
}
