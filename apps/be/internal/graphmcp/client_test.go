package graphmcp

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/0xHelico/helico/apps/be/internal/graphmcp/graphmcptest"
)

// newFake starts the fake server and closes it with the test.
func newFake(t *testing.T, handle func(name string, args map[string]any) (string, bool, *RPCError)) *graphmcptest.Fake {
	t.Helper()
	f := graphmcptest.NewFake(func(name string, args map[string]any) (string, bool, *graphmcptest.RPCError) {
		text, isErr, e := handle(name, args)
		if e != nil {
			return "", false, &graphmcptest.RPCError{Code: e.Code, Message: e.Message}
		}
		return text, isErr, nil
	})
	t.Cleanup(f.Close)
	return f
}

func TestHandshakeThenCall(t *testing.T) {
	fake := newFake(t, func(name string, args map[string]any) (string, bool, *RPCError) {
		if name != ToolExecuteBySubgraphID {
			return "", false, &RPCError{Code: -32601, Message: "unknown tool " + name}
		}
		return `{"data":{"_meta":{"block":{"number":42}}}}`, false, nil
	})
	c := New(fake.URL(), "", 5*time.Second)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	s, err := c.Open(ctx)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer s.Close()
	if s.Server != "fake-subgraph-mcp 0.0.1" {
		t.Fatalf("server = %q", s.Server)
	}

	tools, err := s.Tools(ctx)
	if err != nil || len(tools) != 2 {
		t.Fatalf("tools = %v, %v", tools, err)
	}

	res, err := s.Call(ctx, ToolExecuteBySubgraphID, map[string]any{"subgraph_id": "abc", "query": "{ _meta { block { number } } }"})
	if err != nil {
		t.Fatalf("call: %v", err)
	}
	if res.IsError || !strings.Contains(res.Text, `"number":42`) {
		t.Fatalf("result = %+v", res)
	}
	if len(fake.Calls()) != 1 || fake.Calls()[0].Args["subgraph_id"] != "abc" {
		t.Fatalf("recorded calls = %+v", fake.Calls())
	}
	if fake.Auth() != "" {
		t.Fatalf("no key was configured but Authorization was %q", fake.Auth())
	}
}

func TestAnRPCErrorIsAnError(t *testing.T) {
	fake := newFake(t, func(string, map[string]any) (string, bool, *RPCError) {
		return "", false, &RPCError{Code: -32603, Message: "GraphQL error: subgraph not found: Qm…"}
	})
	c := New(fake.URL(), "", 5*time.Second)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s, err := c.Open(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	_, err = s.Call(ctx, ToolExecuteBySubgraphID, nil)
	if err == nil || !strings.Contains(err.Error(), "subgraph not found") {
		t.Fatalf("err = %v, want the server's message", err)
	}
}

func TestTheKeyTravelsAsBearer(t *testing.T) {
	fake := newFake(t, func(string, map[string]any) (string, bool, *RPCError) { return "{}", false, nil })
	c := New(fake.URL(), "gateway-key", 5*time.Second)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s, err := c.Open(ctx)
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	if fake.Auth() != "Bearer gateway-key" {
		t.Fatalf("Authorization = %q", fake.Auth())
	}
}

func TestUnconfiguredIsNotAnOutage(t *testing.T) {
	c := New("", "", 0)
	if c.Configured() {
		t.Fatal("empty URL reported configured")
	}
	if _, err := c.Open(context.Background()); err != ErrNotConfigured {
		t.Fatalf("err = %v", err)
	}
}

func TestAServerThatIsNotAnEventStreamIsRefused(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("<html>not mcp</html>"))
	}))
	t.Cleanup(srv.Close)
	c := New(srv.URL, "", time.Second)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, err := c.Open(ctx); err == nil || !strings.Contains(err.Error(), "not an event stream") {
		t.Fatalf("err = %v", err)
	}
}

func TestAStreamThatDiesFailsTheCall(t *testing.T) {
	// The server names an endpoint and then hangs up on the first POST's answer.
	mux := http.NewServeMux()
	var srv *httptest.Server
	mux.HandleFunc("GET /sse", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		fmt.Fprint(w, "event: endpoint\ndata: /messages?sessionId=x\n\n")
		w.(http.Flusher).Flush()
		// Return: the stream ends without ever answering.
	})
	mux.HandleFunc("POST /messages", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(202) })
	srv = httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	c := New(srv.URL, "", time.Second)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, err := c.Open(ctx)
	if err == nil || !strings.Contains(err.Error(), "ended") {
		t.Fatalf("err = %v, want the stream ending reported", err)
	}
}

// TestLiveSubgraphMCP asks the real server the question measured on 12 September. It is skipped
// unless GRAPH_MCP_LIVE=1, because CI has no business depending on The Graph's uptime, and
// because the assertion is about a public subgraph's head block, which only has to be a number.
func TestLiveSubgraphMCP(t *testing.T) {
	if os.Getenv("GRAPH_MCP_LIVE") != "1" {
		t.Skip("GRAPH_MCP_LIVE=1 to run against https://subgraphs.mcp.thegraph.com")
	}
	c := New("https://subgraphs.mcp.thegraph.com", os.Getenv("GRAPH_MCP_API_KEY"), 30*time.Second)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	s, err := c.Open(ctx)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer s.Close()
	t.Logf("server: %s", s.Server)
	tools, err := s.Tools(ctx)
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, tl := range tools {
		names[tl.Name] = true
	}
	for _, want := range []string{ToolExecuteBySubgraphID, ToolSchemaBySubgraphID, ToolSearchByKeyword, ToolTopDeployments} {
		if !names[want] {
			t.Fatalf("tool %s missing from %v", want, names)
		}
	}
	// Aave V3 Arbitrum, found by keyword on 12 September 2026.
	res, err := s.Call(ctx, ToolExecuteBySubgraphID, map[string]any{
		"subgraph_id": "4xyasjQeREe7PxnF6wVdobZvCw5mhoHZq3T7guRpuNPf",
		"query":       "{ _meta { block { number } } }",
	})
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	var out struct {
		Data struct {
			Meta struct {
				Block struct{ Number int64 }
			} `json:"_meta"`
		}
	}
	if err := json.Unmarshal([]byte(res.Text), &out); err != nil || out.Data.Meta.Block.Number == 0 {
		t.Fatalf("result = %+v (%v): %s", res, err, res.Text)
	}
	t.Logf("Aave V3 Arbitrum head block via MCP: %d", out.Data.Meta.Block.Number)
}
