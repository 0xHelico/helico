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
		`{"answer":"The index shows your account 0x0acd, opened by your wallet, holding nothing idle."}`,
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
	var card *struct {
		Title string   `json:"title"`
		Body  string   `json:"body"`
		Tags  []string `json:"tags"`
	}
	for i := range got.Cards {
		if got.Cards[i].Title == "From the index" {
			card = &got.Cards[i]
		}
	}
	if card == nil || !strings.Contains(card.Body, "0x0acd") || len(card.Tags) != 3 || card.Tags[1] != "Subgraph MCP" || card.Tags[2] != "1 query" {
		t.Fatalf("card = %+v", card)
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
	srv, _, _ := indexServer(t, "helico-sub", []string{`{"action":"status"}`, `{"answer":"General answer."}`}, answers)
	res, body := do(t, http.MethodPost, srv.URL+"/api/swap/intent", map[string]string{"message": "status", "address": "not-an-address"}, nil)
	if res.StatusCode != http.StatusOK || !strings.Contains(string(body), "General answer.") {
		t.Fatalf("status = %d: %s", res.StatusCode, body)
	}
}
