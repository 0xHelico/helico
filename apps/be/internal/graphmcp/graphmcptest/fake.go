// Package graphmcptest is an MCP server over the same SSE transport the real Subgraph MCP uses,
// in a few dozen lines: `GET /sse` names `/messages?sessionId=…`, every POST there is answered
// on the stream. The shape is the one measured on 12 September 2026, down to the 202 the real
// server answers a POST with. It exists so the packages that read the index can be tested
// without The Graph being reachable.
package graphmcptest

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"time"
)

// RPCError mirrors graphmcp.RPCError without importing it, so this package has no dependency
// on the package it fakes and the two can be tested independently.
type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// Handler answers one tools/call: the text, whether it is flagged as an error, or an RPC error.
type Handler func(name string, args map[string]any) (string, bool, *RPCError)

// Call is one recorded tools/call.
type Call struct {
	Name string
	Args map[string]any
}

// Fake is the server. Close it when done.
type Fake struct {
	handle Handler
	mu     sync.Mutex
	calls  []Call
	auth   string

	streams sync.Map // sessionId → chan []byte
	srv     *httptest.Server
}

// NewFake starts the server with the given handler. Schema and list requests are answered by
// the fake itself; tools/call goes to the handler.
func NewFake(handle Handler) *Fake {
	f := &Fake{handle: handle}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /sse", f.sse)
	mux.HandleFunc("POST /messages", f.message)
	f.srv = httptest.NewServer(mux)
	return f
}

// URL is the base URL a client is pointed at.
func (f *Fake) URL() string { return f.srv.URL }

// Close stops the server.
func (f *Fake) Close() { f.srv.Close() }

// Calls is every tools/call so far, in order.
func (f *Fake) Calls() []Call {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Call(nil), f.calls...)
}

// Auth is the Authorization header the last stream was opened with.
func (f *Fake) Auth() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.auth
}

func (f *Fake) sse(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.auth = r.Header.Get("Authorization")
	f.mu.Unlock()
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "no flusher", 500)
		return
	}
	id := fmt.Sprintf("s%d", time.Now().UnixNano())
	ch := make(chan []byte, 16)
	f.streams.Store(id, ch)
	defer f.streams.Delete(id)
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(200)
	fmt.Fprintf(w, "event: endpoint\ndata: /messages?sessionId=%s\n\n", id)
	fl.Flush()
	for {
		select {
		case msg := <-ch:
			fmt.Fprintf(w, "event: message\ndata: %s\n\n", msg)
			fl.Flush()
		case <-r.Context().Done():
			return
		}
	}
}

func (f *Fake) message(w http.ResponseWriter, r *http.Request) {
	v, ok := f.streams.Load(r.URL.Query().Get("sessionId"))
	if !ok {
		http.Error(w, "no such session", 404)
		return
	}
	ch := v.(chan []byte)
	var req struct {
		ID     *int64 `json:"id"`
		Method string `json:"method"`
		Params struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		} `json:"params"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	w.WriteHeader(http.StatusAccepted)
	if req.ID == nil {
		return // a notification
	}
	reply := func(result any, rpcErr *RPCError) {
		out := map[string]any{"jsonrpc": "2.0", "id": *req.ID}
		if rpcErr != nil {
			out["error"] = rpcErr
		} else {
			out["result"] = result
		}
		b, _ := json.Marshal(out)
		ch <- b
	}
	switch req.Method {
	case "initialize":
		reply(map[string]any{
			"protocolVersion": "2024-11-05",
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "fake-subgraph-mcp", "version": "0.0.1"},
		}, nil)
	case "tools/list":
		reply(map[string]any{"tools": []map[string]any{
			{"name": "execute_query_by_subgraph_id", "description": "Execute a GraphQL query against the latest deployment of a subgraph ID."},
			{"name": "get_schema_by_subgraph_id", "description": "Get the schema for the current version of a subgraph."},
		}}, nil)
	case "tools/call":
		f.mu.Lock()
		f.calls = append(f.calls, Call{Name: req.Params.Name, Args: req.Params.Arguments})
		f.mu.Unlock()
		text, isErr, rpcErr := f.handle(req.Params.Name, req.Params.Arguments)
		if rpcErr != nil {
			reply(nil, rpcErr)
			return
		}
		reply(map[string]any{
			"content": []map[string]any{{"type": "text", "text": text}},
			"isError": isErr,
		}, nil)
	default:
		reply(nil, &RPCError{Code: -32601, Message: "method not found"})
	}
}
