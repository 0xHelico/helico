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
	"sync/atomic"
	"testing"
	"time"

	"github.com/0xHelico/helico/apps/be/internal/blog"
	"github.com/0xHelico/helico/apps/be/internal/graphmcp"
	"github.com/0xHelico/helico/apps/be/internal/graphmcp/graphmcptest"
	"github.com/0xHelico/helico/apps/be/internal/store"
	"github.com/0xHelico/helico/apps/be/internal/swap"
)

// indexServer builds the API with a scripted model and a fake Subgraph MCP behind the intent
// route. The first model answer is the intent; the rest are the read loop's turns. `subgraphID`
// empty leaves the index unconfigured — the state a deployment starts in.
func indexServer(t *testing.T, subgraphID string, script []string, handle graphmcptest.Handler) (*httptest.Server, *graphmcptest.Fake, *atomic.Int32) {
	t.Helper()
	var calls atomic.Int32
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		n := int(calls.Add(1)) - 1
		content := `{"answer":"nothing scripted"}`
		if n < len(script) {
			content = script[n]
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{"message": map[string]string{"role": "assistant", "content": content}}},
		})
	}))
	t.Cleanup(model.Close)
	fake := graphmcptest.NewFake(handle)
	t.Cleanup(fake.Close)

	db, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "api.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	h := New(blog.NewService(db), Options{
		Logger:         slog.New(slog.NewTextHandler(io.Discard, nil)),
		RequestTimeout: 5 * time.Second,
		Swap:           swap.New(swap.NewClient(5*time.Second, swap.Upstream{BaseURL: model.URL, Key: "k", Model: "test-model"})),
		Index: &swap.Index{
			MCP:        graphmcp.New(fake.URL(), "", 5*time.Second),
			SubgraphID: subgraphID,
			MaxQueries: 3,
			Timeout:    8 * time.Second,
		},
		SwapRatePerMin: 10,
		SwapDailyMax:   100,
	})
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv, fake, &calls
}

type indexReply struct {
	Reply  string `json:"reply"`
	Action string `json:"action"`
	Cards  []struct {
		Title string   `json:"title"`
		Body  string   `json:"body"`
		Tags  []string `json:"tags"`
	} `json:"cards"`
	Steps []struct {
		Call   string `json:"call"`
		Detail string `json:"detail"`
		OK     bool   `json:"ok"`
	} `json:"steps"`
}

func answers(name string, args map[string]any) (string, bool, *graphmcptest.RPCError) {
	if name == graphmcp.ToolSchemaBySubgraphID {
		return "type Account @entity { id: Bytes! owner: Bytes! }", false, nil
	}
	return `{"data":{"accounts":[{"id":"0x0acd","owner":"0x3b4f"}]}}`, false, nil
}

func TestAStatusQuestionReadsTheIndex(t *testing.T) {
	srv, fake, _ := indexServer(t, "helico-sub", []string{
		`{"action":"status"}`,
		`{"query":"{ accounts(where:{owner:\"0x3b4f\"}) { id } }","why":"find the account"}`,
		`{"answer":"The agent's moves into lending markets are not in this index. The index holds no mandates for 0x0acdfa21a3cd075aee6583c8a8069f86ad3e4a39, opened in tx 0x0673389b803b0b2a60c828ee0b1a7cb4984f00a0960e4b8b85fa66972181ce61. Nothing else."}`,
	}, answers)
	res, body := do(t, http.MethodPost, srv.URL+"/api/swap/intent", map[string]string{
		"message": "why has nothing moved?", "address": "0x3B4F0135465d444A5BD06Ab90fC59B73916C85F5",
	}, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d: %s", res.StatusCode, body)
	}
	var got indexReply
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	if got.Action != "status" || !strings.Contains(got.Reply, "read straight from the chain") {
		t.Fatalf("the status reply changed: %+v", got)
	}
	// **The index's sentence is a step, not a card** (#455, #464). No card; the model's reading
	// is the last step under the calls that produced it, capped to two sentences with every
	// hash and full address cut to its ends.
	for _, c := range got.Cards {
		if c.Title == "From the index" {
			t.Fatalf("the index answered with a card: %+v", c)
		}
	}
	last := got.Steps[len(got.Steps)-1]
	if last.Call != "index.answer" || !last.OK {
		t.Fatalf("the last step is not the index's answer: %+v", last)
	}
	if !strings.HasPrefix(last.Detail, "The agent's moves into lending markets are not in this index.") {
		t.Fatalf("the sentence lost its first clause: %q", last.Detail)
	}
	if strings.Contains(last.Detail, "Nothing else") {
		t.Fatalf("a third sentence survived: %q", last.Detail)
	}
	if strings.Contains(last.Detail, "0x0acdfa21a3cd075aee6583c8a8069f86ad3e4a39") || strings.Contains(last.Detail, "0x0673389b803b0b2a60c828ee0b1a7cb4984f00a0960e4b8b85fa66972181ce61") {
		t.Fatalf("a full address or hash survived: %q", last.Detail)
	}
	if !strings.Contains(last.Detail, "0x0acd…4a39") {
		t.Fatalf("the address was not shortened: %q", last.Detail)
	}
	var mcpSteps int
	for _, s := range got.Steps {
		if strings.HasPrefix(s.Call, "mcp.") {
			mcpSteps++
			if !s.OK {
				t.Fatalf("step failed: %+v", s)
			}
		}
	}
	if mcpSteps != 3 { // initialize, schema, one query
		t.Fatalf("mcp steps = %d in %+v", mcpSteps, got.Steps)
	}
	// Named rather than counted, because the count is what a reader cannot check. These are the
	// calls that make The Graph load-bearing rather than mentioned, and they are the evidence the
	// card used to paraphrase.
	for _, want := range []string{"mcp.initialize", "mcp." + graphmcp.ToolSchemaBySubgraphID, "mcp." + graphmcp.ToolExecuteBySubgraphID} {
		var seen bool
		for _, s := range got.Steps {
			if s.Call == want {
				seen = true
			}
		}
		if !seen {
			t.Errorf("%s is not in the steps: %+v", want, got.Steps)
		}
	}
	// The wallet reached the model lowercased, and the query went to the pinned subgraph.
	calls := fake.Calls()
	if len(calls) != 2 || calls[1].Args["subgraph_id"] != "helico-sub" {
		t.Fatalf("mcp calls = %+v", calls)
	}
}

func TestTheIndexFailingLeavesTheReplyAlone(t *testing.T) {
	srv, _, _ := indexServer(t, "helico-sub", []string{`{"action":"status"}`}, func(name string, _ map[string]any) (string, bool, *graphmcptest.RPCError) {
		return "", false, &graphmcptest.RPCError{Code: -32603, Message: "GraphQL error: subgraph not found: helico-sub"}
	})
	res, body := do(t, http.MethodPost, srv.URL+"/api/swap/intent", map[string]string{"message": "check my portfolio"}, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d: %s", res.StatusCode, body)
	}
	var got indexReply
	_ = json.Unmarshal(body, &got)
	for _, c := range got.Cards {
		if c.Title == "From the index" {
			t.Fatalf("a failed read produced a card: %+v", c)
		}
	}
	var failed bool
	for _, s := range got.Steps {
		if s.Call == "mcp."+graphmcp.ToolSchemaBySubgraphID && !s.OK && strings.Contains(s.Detail, "subgraph not found") {
			failed = true
		}
	}
	if !failed {
		t.Fatalf("the failure is not in the steps: %+v", got.Steps)
	}
	if !strings.Contains(got.Reply, "read straight from the chain") {
		t.Fatalf("the reply changed: %q", got.Reply)
	}
}

func TestWithoutAnIndexTheStatusAnswerIsUnchanged(t *testing.T) {
	srv, fake, modelCalls := indexServer(t, "", []string{`{"action":"status"}`}, answers)
	res, body := do(t, http.MethodPost, srv.URL+"/api/swap/intent", map[string]string{"message": "check my portfolio"}, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d: %s", res.StatusCode, body)
	}
	if strings.Contains(string(body), "From the index") || strings.Contains(string(body), "mcp.") {
		t.Fatalf("the index leaked into an unconfigured answer: %s", body)
	}
	if len(fake.Calls()) != 0 || modelCalls.Load() != 1 {
		t.Fatalf("mcp calls = %d, model calls = %d; want none and one", len(fake.Calls()), modelCalls.Load())
	}
}

func TestOnlyAStatusQuestionReadsTheIndex(t *testing.T) {
	srv, fake, modelCalls := indexServer(t, "helico-sub", []string{`{"action":"about"}`}, answers)
	res, _ := do(t, http.MethodPost, srv.URL+"/api/swap/intent", map[string]string{"message": "what can you do?"}, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", res.StatusCode)
	}
	if len(fake.Calls()) != 0 || modelCalls.Load() != 1 {
		t.Fatalf("an 'about' question reached the index: mcp %d, model %d", len(fake.Calls()), modelCalls.Load())
	}
}

func TestAMalformedAddressIsIgnoredNotRefused(t *testing.T) {
	srv, fake, _ := indexServer(t, "helico-sub", []string{`{"action":"status"}`, `{"answer":"General answer."}`}, answers)
	res, body := do(t, http.MethodPost, srv.URL+"/api/swap/intent", map[string]string{"message": "status", "address": "not-an-address"}, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d: %s", res.StatusCode, body)
	}
	// Ignored, not refused: the answer is the one a status question always gets, and the index was
	// still read — with no owner to filter by, which is what "ignored" means here.
	//
	// This used to look for the index's own sentence in the body. That sentence is no longer put
	// on screen, and a test that reached for it was measuring where the answer was displayed
	// rather than whether the bad address stopped anything.
	if !strings.Contains(string(body), "read straight from the chain") {
		t.Fatalf("the reply changed: %s", body)
	}
	if len(fake.Calls()) == 0 {
		t.Fatal("the index was not read at all")
	}
}
