package swap

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/0xHelico/helico/apps/be/internal/graphmcp"
	"github.com/0xHelico/helico/apps/be/internal/graphmcp/graphmcptest"
)

// scriptedModel answers each /chat/completions call with the next script entry, and records
// every request so a test can read what the model was shown.
type scriptedModel struct {
	t        *testing.T
	script   []string
	requests [][]chatMessage
	client   *Client
}

func newScriptedModel(t *testing.T, script ...string) *scriptedModel {
	t.Helper()
	m := &scriptedModel{t: t, script: script}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req chatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Errorf("decode: %v", err)
		}
		m.requests = append(m.requests, req.Messages)
		if len(m.script) == 0 {
			t.Errorf("the model was asked a %dth time with nothing scripted", len(m.requests))
			w.WriteHeader(500)
			return
		}
		next := m.script[0]
		m.script = m.script[1:]
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []map[string]any{{"message": map[string]string{"role": "assistant", "content": next}}}})
	}))
	t.Cleanup(srv.Close)
	m.client = NewClient(5*time.Second, Upstream{BaseURL: srv.URL, Key: "test-key", Model: "test-model"})
	return m
}

const fakeSchema = "type Account @entity { id: Bytes! owner: Bytes! }\ntype Mandate @entity { id: Bytes! maker: Maker! active: Boolean! }"

func fakeIndex(t *testing.T, handle func(name string, args map[string]any) (string, bool, error)) (*Index, *graphmcptest.Fake) {
	t.Helper()
	fake := graphmcptest.NewFake(func(name string, args map[string]any) (string, bool, *graphmcptest.RPCError) {
		if name == graphmcp.ToolSchemaBySubgraphID {
			return fakeSchema, false, nil
		}
		text, isErr, err := handle(name, args)
		if err != nil {
			return "", false, &graphmcptest.RPCError{Code: -32603, Message: err.Error()}
		}
		return text, isErr, nil
	})
	t.Cleanup(fake.Close)
	idx := &Index{MCP: graphmcp.New(fake.URL(), "", 5*time.Second), SubgraphID: "helico-sub", MaxQueries: 3, Timeout: 10 * time.Second}
	return idx, fake
}

func TestAskReadsThenAnswers(t *testing.T) {
	model := newScriptedModel(t,
		`{"query":"{ accounts(where:{owner:\"0xabc\"}) { id } }","variables":{},"why":"find the account"}`,
		`{"answer":"The index shows one account, 0x0acd…, opened by your wallet."}`,
	)
	idx, fake := fakeIndex(t, func(name string, args map[string]any) (string, bool, error) {
		if args["subgraph_id"] != "helico-sub" {
			t.Errorf("subgraph_id = %v, want the pinned one", args["subgraph_id"])
		}
		return `{"data":{"accounts":[{"id":"0x0acd"}]}}`, false, nil
	})
	svc := New(model.client)

	got, steps, err := svc.Ask(context.Background(), idx, "which account is mine?", "0xabc")
	if err != nil {
		t.Fatalf("ask: %v (steps %+v)", err, steps)
	}
	if got.Queries != 1 || !strings.Contains(got.Answer, "one account") || got.Server == "" {
		t.Fatalf("answer = %+v", got)
	}
	// The model was shown the schema and told whose wallet it is.
	sys := model.requests[0][0].Content
	if !strings.Contains(sys, "type Account @entity") || !strings.Contains(sys, "0xabc") {
		t.Fatalf("system prompt lacked the schema or the owner:\n%s", sys[:200])
	}
	// Then shown its own query and the result before answering.
	second := model.requests[1]
	if second[len(second)-1].Role != "user" || !strings.Contains(second[len(second)-1].Content, `"accounts"`) {
		t.Fatalf("the result did not reach the model: %+v", second[len(second)-1])
	}
	// Steps: initialize, schema, one query — every one ok.
	if len(steps) != 3 || steps[2].Call != "mcp."+graphmcp.ToolExecuteBySubgraphID || !steps[2].OK || !strings.Contains(steps[2].Detail, "find the account") {
		t.Fatalf("steps = %+v", steps)
	}
	if len(fake.Calls()) != 2 { // schema + query
		t.Fatalf("mcp calls = %+v", fake.Calls())
	}
}

func TestAskFeedsARefusalBackAndCanRecover(t *testing.T) {
	model := newScriptedModel(t,
		`{"query":"{ nonsense { id } }","why":"wrong"}`,
		`{"query":"{ accounts(first:1) { id } }","why":"fixed"}`,
		`{"answer":"One account."}`,
	)
	calls := 0
	idx, _ := fakeIndex(t, func(name string, args map[string]any) (string, bool, error) {
		calls++
		if strings.Contains(args["query"].(string), "nonsense") {
			return "", false, errorf("GraphQL error: Cannot query field nonsense")
		}
		return `{"data":{"accounts":[{"id":"0x1"}]}}`, false, nil
	})
	got, steps, err := svc(model).Ask(context.Background(), idx, "how many accounts?", "")
	if err != nil {
		t.Fatalf("ask: %v", err)
	}
	if got.Queries != 2 || calls != 2 {
		t.Fatalf("queries = %d, calls = %d", got.Queries, calls)
	}
	if steps[2].OK || !strings.Contains(steps[2].Detail, "Cannot query field") || !steps[3].OK {
		t.Fatalf("steps = %+v", steps)
	}
	// The refusal was shown to the model, so the second query could be a fix rather than a guess.
	shown := model.requests[1][len(model.requests[1])-1].Content
	if !strings.Contains(shown, "refused") || !strings.Contains(shown, "Cannot query field") {
		t.Fatalf("the refusal did not reach the model: %s", shown)
	}
	// Without a wallet the model is told so.
	if !strings.Contains(model.requests[0][0].Content, "did not connect a wallet") {
		t.Fatal("the model was not told there is no wallet")
	}
}

func TestAskStopsAtTheQueryLimit(t *testing.T) {
	model := newScriptedModel(t,
		`{"query":"{ a { id } }"}`, `{"query":"{ b { id } }"}`, `{"query":"{ c { id } }"}`, `{"query":"{ d { id } }"}`,
	)
	idx, fake := fakeIndex(t, func(string, map[string]any) (string, bool, error) { return `{"data":{}}`, false, nil })
	_, steps, err := svc(model).Ask(context.Background(), idx, "loop forever", "")
	if err == nil || !strings.Contains(err.Error(), "ran out of queries") {
		t.Fatalf("err = %v", err)
	}
	if len(fake.Calls()) != 1+3 { // schema + MaxQueries
		t.Fatalf("mcp calls = %d, want the limit respected", len(fake.Calls()))
	}
	last := steps[len(steps)-1]
	if last.OK || !strings.Contains(last.Detail, "limit is 3") {
		t.Fatalf("last step = %+v", last)
	}
}

func TestAskTruncatesABigResult(t *testing.T) {
	big := strings.Repeat("x", maxResultBytes+100)
	model := newScriptedModel(t, `{"query":"{ big { id } }"}`, `{"answer":"too much"}`)
	idx, _ := fakeIndex(t, func(string, map[string]any) (string, bool, error) { return big, false, nil })
	if _, _, err := svc(model).Ask(context.Background(), idx, "q", ""); err != nil {
		t.Fatal(err)
	}
	shown := model.requests[1][len(model.requests[1])-1].Content
	if len(shown) > maxResultBytes+200 || !strings.Contains(shown, "truncated") {
		t.Fatalf("result shown to the model was %d bytes and %q", len(shown), shown[len(shown)-60:])
	}
}

func TestAskWithoutAnIndexIsNotConfigured(t *testing.T) {
	model := newScriptedModel(t)
	_, _, err := svc(model).Ask(context.Background(), &Index{MCP: graphmcp.New("", "", 0)}, "q", "")
	if err != graphmcp.ErrNotConfigured {
		t.Fatalf("err = %v", err)
	}
	_, _, err = svc(model).Ask(context.Background(), nil, "q", "")
	if err != graphmcp.ErrNotConfigured {
		t.Fatalf("nil index: err = %v", err)
	}
}

func TestAskReadsTheSchemaOnceWithinTheTTL(t *testing.T) {
	model := newScriptedModel(t, `{"answer":"a"}`, `{"answer":"b"}`)
	idx, fake := fakeIndex(t, func(string, map[string]any) (string, bool, error) { return "{}", false, nil })
	idx.SchemaTTL = time.Hour
	s := svc(model)
	if _, _, err := s.Ask(context.Background(), idx, "q1", ""); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Ask(context.Background(), idx, "q2", ""); err != nil {
		t.Fatal(err)
	}
	schemaReads := 0
	for _, c := range fake.Calls() {
		if c.Name == graphmcp.ToolSchemaBySubgraphID {
			schemaReads++
		}
	}
	if schemaReads != 1 {
		t.Fatalf("schema read %d times across two questions", schemaReads)
	}
}

func svc(m *scriptedModel) *Service { return New(m.client) }

type stringError string

func (e stringError) Error() string { return string(e) }
func errorf(s string) error         { return stringError(s) }

// TestLiveAsk runs the whole loop — real model, real Subgraph MCP, a public subgraph — and is
// skipped unless GRAPH_MCP_LIVE=1 with LLM_BASE_URL, LLM_API_KEY and LLM_MODEL set. It exists
// to prove the prompt works with the model production uses, which no fake can.
func TestLiveAsk(t *testing.T) {
	if os.Getenv("GRAPH_MCP_LIVE") != "1" || os.Getenv("LLM_API_KEY") == "" {
		t.Skip("GRAPH_MCP_LIVE=1 and LLM_* to run against the real model and MCP")
	}
	subgraph := os.Getenv("GRAPH_MCP_SUBGRAPH_ID")
	if subgraph == "" {
		subgraph = "4xyasjQeREe7PxnF6wVdobZvCw5mhoHZq3T7guRpuNPf" // Aave V3 Arbitrum
	}
	question := os.Getenv("ASK")
	if question == "" {
		question = "What is the current liquidity rate of the USDC reserve, and how many reserves does the index know?"
	}
	svc := New(NewClient(25*time.Second, Upstream{
		BaseURL: os.Getenv("LLM_BASE_URL"),
		Key:     os.Getenv("LLM_API_KEY"),
		Model:   os.Getenv("LLM_MODEL"),
		User:    os.Getenv("LLM_USER"),
		Pass:    os.Getenv("LLM_PASS"),
	}))
	idx := &Index{
		MCP:          graphmcp.New("https://subgraphs.mcp.thegraph.com", os.Getenv("GRAPH_MCP_API_KEY"), 15*time.Second),
		SubgraphID:   subgraph,
		MaxQueries:   5,
		Timeout:      90 * time.Second,
		ModelTimeout: 40 * time.Second,
		Trace: func(kind, text string) {
			if os.Getenv("ASK_DEBUG") == "1" {
				t.Logf("%s: %s", kind, text)
			}
		},
	}
	start := time.Now()
	got, steps, err := svc.Ask(context.Background(), idx, question, os.Getenv("ASK_OWNER"))
	for _, s := range steps {
		t.Logf("step  ok=%-5v %-40s %s", s.OK, s.Call, s.Detail)
	}
	if err != nil {
		t.Fatalf("ask: %v", err)
	}
	t.Logf("answer (%d queries, %s): %s", got.Queries, time.Since(start).Round(time.Millisecond), got.Answer)
}

func TestWrapQueryGivesABareSelectionItsBraces(t *testing.T) {
	for in, want := range map[string]string{
		`accounts(where:{owner:"0xab"}) { id }`: `{ accounts(where:{owner:"0xab"}) { id } }`,
		`{ accounts { id } }`:                   `{ accounts { id } }`,
		`query Q { accounts { id } }`:           `query Q { accounts { id } }`,
		"  \n{ _meta { block { number } } }\n":  `{ _meta { block { number } } }`,
	} {
		if got := wrapQuery(in); got != want {
			t.Errorf("wrapQuery(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestAskSendsAZeroQueryAnswerBackOnce(t *testing.T) {
	model := newScriptedModel(t,
		`{"answer":"Nothing moved, the index does not track that."}`,
		`{"query":"accounts(where:{owner:\"0xabc\"}) { id openedAt }","why":"the account"}`,
		`{"answer":"Your account 0x0acd was opened on 10 September; the index holds no mandates for it."}`,
	)
	idx, fake := fakeIndex(t, func(name string, args map[string]any) (string, bool, error) {
		if q := args["query"].(string); !strings.HasPrefix(q, "{ accounts") {
			t.Errorf("query was not wrapped: %q", q)
		}
		return `{"data":{"accounts":[{"id":"0x0acd","openedAt":"1789063118"}]}}`, false, nil
	})
	got, steps, err := svc(model).Ask(context.Background(), idx, "why has nothing moved?", "0xabc")
	if err != nil {
		t.Fatalf("ask: %v (%+v)", err, steps)
	}
	if got.Queries != 1 || !strings.Contains(got.Answer, "0x0acd") {
		t.Fatalf("answer = %+v", got)
	}
	// The nudge was shown to the model, once.
	shown := model.requests[1][len(model.requests[1])-1].Content
	if !strings.Contains(shown, "answered without reading") {
		t.Fatalf("no nudge: %s", shown)
	}
	if len(fake.Calls()) != 2 {
		t.Fatalf("mcp calls = %+v", fake.Calls())
	}
}

func TestAskAcceptsAZeroQueryAnswerWhenThereIsNoWallet(t *testing.T) {
	model := newScriptedModel(t, `{"answer":"Connect a wallet and I can look."}`)
	idx, _ := fakeIndex(t, func(string, map[string]any) (string, bool, error) { return "{}", false, nil })
	got, _, err := svc(model).Ask(context.Background(), idx, "why has nothing moved?", "")
	if err != nil || got.Queries != 0 {
		t.Fatalf("got %+v, %v", got, err)
	}
}

func TestTimeLegendConvertsUnixSecondsForTheModel(t *testing.T) {
	got := timeLegend(`{"data":{"accounts":[{"openedAt":"1789063118","openedAtBlock":"503787461"}]}}`)
	if !strings.Contains(got, "1789063118 = 2026-09-10 17:58:38 UTC") {
		t.Fatalf("legend = %q", got)
	}
	if strings.Contains(got, "503787461") {
		t.Fatalf("a block number was mistaken for a timestamp: %q", got)
	}
	if timeLegend(`{"data":{"accounts":[]}}`) != "" {
		t.Fatal("an empty result grew a legend")
	}
}

func TestSelectsNoFields(t *testing.T) {
	for q, want := range map[string]bool{
		`{ accounts(where:{owner:"0xab"}) }`:        true,
		`{ accounts(where:{owner:"0xab"}) { id } }`: false,
		`{ _meta { block { number } } }`:            false,
		`query Q { accounts { id } }`:               false,
		`{ makers(first: 5) }`:                      true,
	} {
		if got := selectsNoFields(q); got != want {
			t.Errorf("selectsNoFields(%q) = %v, want %v", q, got, want)
		}
	}
}

func TestAskRefusesAFieldlessQueryBeforeAskingTheIndex(t *testing.T) {
	model := newScriptedModel(t,
		`{"query":"accounts(where:{owner:\"0xabc\"})","why":"find the account"}`,
		`{"query":"{ accounts(where:{owner:\"0xabc\"}) { id } }","why":"with fields"}`,
		`{"answer":"Your account is 0x0acd."}`,
	)
	idx, fake := fakeIndex(t, func(string, map[string]any) (string, bool, error) {
		return `{"data":{"accounts":[{"id":"0x0acd"}]}}`, false, nil
	})
	got, steps, err := svc(model).Ask(context.Background(), idx, "check my portfolio", "0xabc")
	if err != nil {
		t.Fatalf("ask: %v", err)
	}
	if got.Queries != 1 || len(fake.Calls()) != 2 { // schema + the one real query
		t.Fatalf("queries = %d, mcp calls = %+v", got.Queries, fake.Calls())
	}
	if steps[2].OK || !strings.Contains(steps[2].Detail, "selected no fields") {
		t.Fatalf("the refusal is not a step: %+v", steps[2])
	}
	shown := model.requests[1][len(model.requests[1])-1].Content
	if !strings.Contains(shown, "selects no fields") {
		t.Fatalf("the model was not told why: %s", shown)
	}
}
