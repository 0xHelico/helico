// Package graphmcp speaks to The Graph's Subgraph MCP server.
//
// The server is an MCP (Model Context Protocol) endpoint over the SSE transport of the
// 2024-11-05 specification: a client opens `GET /sse`, receives an `endpoint` event naming where
// to POST, and every JSON-RPC request it posts is answered on the stream it holds open. It is
// The Graph's own product — the second Graph product this application composes with its
// Subgraph — and what it does for the chat is let a model read a subgraph's schema and run
// GraphQL against it without this code knowing the query in advance.
//
// Measured on 12 September 2026 (`docs/plans/2026-09-12-the-chat-reads-the-index.md`): the
// server answers `initialize` with `subgraph-mcp 0.1.1`, lists nine tools, and executes queries on
// network subgraphs with no API key. The docs describe a Gateway API key as a Bearer header; it
// is sent when configured and the server works either way. Only subgraphs published to The Graph
// Network are served — a Subgraph Studio deployment answers "subgraph not found".
//
// Deliberately small. One session per question, closed when the question is answered. There is
// no reconnect: a stream that dies mid-question fails that question, and the caller says so.
package graphmcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ProtocolVersion is the MCP revision the server answered with on 12 September 2026.
const ProtocolVersion = "2024-11-05"

// Tool names on the Subgraph MCP server, as `tools/list` returned them. Named here so a typo is
// a compile error in the caller rather than a `-32601` at runtime.
const (
	ToolSearchByKeyword     = "search_subgraphs_by_keyword"
	ToolTopDeployments      = "get_top_subgraph_deployments"
	ToolSchemaBySubgraphID  = "get_schema_by_subgraph_id"
	ToolExecuteBySubgraphID = "execute_query_by_subgraph_id"
)

// maxEventBytes bounds one SSE data line. A schema is tens of kilobytes; a query result the
// caller asked for is bounded by the query; a megabyte is something else.
const maxEventBytes = 4 << 20

// Client opens sessions against one server.
type Client struct {
	BaseURL string
	// APIKey is sent as `Authorization: Bearer` when set. The server does not require it.
	APIKey string
	HTTP   *http.Client
	// UserAgent is sent on every request. The server's edge refuses some default agents.
	UserAgent string
	// timeout bounds each POST; the stream itself is bounded by the caller's context.
	timeout time.Duration
}

// New builds a client. An empty base URL means the feature is off, and Configured says so.
func New(baseURL, apiKey string, timeout time.Duration) *Client {
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	return &Client{
		BaseURL:   strings.TrimSuffix(baseURL, "/"),
		APIKey:    apiKey,
		HTTP:      &http.Client{Timeout: 0}, // the stream is long-lived; the context bounds it
		UserAgent: "helico-be/1 (+https://helico.site)",
		timeout:   timeout,
	}
}

// Configured reports whether there is a server to talk to.
func (c *Client) Configured() bool { return c != nil && c.BaseURL != "" }

// Session is one open SSE stream with its POST endpoint.
type Session struct {
	client   *Client
	endpoint string
	cancel   context.CancelFunc
	body     io.Closer

	mu      sync.Mutex
	waiting map[int64]chan rpcResponse
	closed  chan struct{}
	readErr error
	next    atomic.Int64

	// Server is what `initialize` answered: name and version, for the log and the step.
	Server string
}

type rpcRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      *int64 `json:"id,omitempty"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

type rpcResponse struct {
	ID     *int64          `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *RPCError       `json:"error"`
}

// RPCError is a JSON-RPC error the server answered with. Exported so a fake can answer with one.
type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *RPCError) Error() string { return fmt.Sprintf("mcp error %d: %s", e.Code, e.Message) }

// ErrNotConfigured is returned by Open when there is no server URL.
var ErrNotConfigured = errors.New("no Subgraph MCP server is configured")

// Open connects, waits for the endpoint, and completes the initialize handshake. The returned
// session must be closed. The context bounds the whole session, not only the handshake.
func (c *Client) Open(ctx context.Context) (*Session, error) {
	if !c.Configured() {
		return nil, ErrNotConfigured
	}
	ctx, cancel := context.WithCancel(ctx)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"/sse", nil)
	if err != nil {
		cancel()
		return nil, err
	}
	req.Header.Set("Accept", "text/event-stream")
	c.decorate(req)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("the MCP server did not answer: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		cancel()
		return nil, fmt.Errorf("the MCP server refused the stream: %s", resp.Status)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		resp.Body.Close()
		cancel()
		return nil, fmt.Errorf("the MCP server answered %q, not an event stream", ct)
	}

	s := &Session{
		client:  c,
		cancel:  cancel,
		body:    resp.Body,
		waiting: map[int64]chan rpcResponse{},
		closed:  make(chan struct{}),
	}
	endpoint := make(chan string, 1)
	go s.read(resp.Body, endpoint)

	select {
	case ep := <-endpoint:
		if ep == "" {
			s.Close()
			return nil, errors.New("the MCP server closed the stream before naming an endpoint")
		}
		s.endpoint = ep
	case <-s.closed:
		err := s.readErr
		s.Close()
		if err == nil {
			err = errors.New("the MCP server closed the stream before naming an endpoint")
		}
		return nil, err
	case <-ctx.Done():
		s.Close()
		return nil, ctx.Err()
	}

	// The handshake. `initialize` is answered; `notifications/initialized` is not.
	var init struct {
		ServerInfo struct {
			Name    string `json:"name"`
			Version string `json:"version"`
		} `json:"serverInfo"`
	}
	res, err := s.call(ctx, "initialize", map[string]any{
		"protocolVersion": ProtocolVersion,
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "helico-be", "version": "1"},
	})
	if err != nil {
		s.Close()
		return nil, fmt.Errorf("initialize: %w", err)
	}
	if err := json.Unmarshal(res, &init); err == nil && init.ServerInfo.Name != "" {
		s.Server = init.ServerInfo.Name + " " + init.ServerInfo.Version
	}
	if err := s.notify(ctx, "notifications/initialized"); err != nil {
		s.Close()
		return nil, fmt.Errorf("initialized: %w", err)
	}
	return s, nil
}

// Close ends the stream. Safe to call more than once.
func (s *Session) Close() {
	s.cancel()
	if s.body != nil {
		s.body.Close()
	}
}

// Tool is one entry of `tools/list`.
type Tool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
}

// Tools lists what the server offers.
func (s *Session) Tools(ctx context.Context) ([]Tool, error) {
	res, err := s.call(ctx, "tools/list", map[string]any{})
	if err != nil {
		return nil, err
	}
	var out struct {
		Tools []Tool `json:"tools"`
	}
	if err := json.Unmarshal(res, &out); err != nil {
		return nil, fmt.Errorf("tools/list answered an unexpected shape: %w", err)
	}
	return out.Tools, nil
}

// Result is what a tool call produced: the text the server returned, and whether the server
// flagged it as an error. A GraphQL error is text with IsError false on this server — the
// caller reads the JSON to tell; a missing subgraph is a JSON-RPC error and comes back as err.
type Result struct {
	Text    string
	IsError bool
}

// Call runs one tool. Text content blocks are joined; other block types are ignored.
func (s *Session) Call(ctx context.Context, name string, args map[string]any) (Result, error) {
	if args == nil {
		args = map[string]any{}
	}
	res, err := s.call(ctx, "tools/call", map[string]any{"name": name, "arguments": args})
	if err != nil {
		return Result{}, err
	}
	var out struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		IsError bool `json:"isError"`
	}
	if err := json.Unmarshal(res, &out); err != nil {
		return Result{}, fmt.Errorf("tools/call answered an unexpected shape: %w", err)
	}
	var b strings.Builder
	for _, c := range out.Content {
		if c.Type == "text" {
			b.WriteString(c.Text)
		}
	}
	return Result{Text: b.String(), IsError: out.IsError}, nil
}

// call posts a request and waits for the matching response on the stream.
func (s *Session) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	id := s.next.Add(1)
	ch := make(chan rpcResponse, 1)
	s.mu.Lock()
	s.waiting[id] = ch
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.waiting, id)
		s.mu.Unlock()
	}()

	if err := s.post(ctx, rpcRequest{JSONRPC: "2.0", ID: &id, Method: method, Params: params}); err != nil {
		return nil, err
	}
	select {
	case r := <-ch:
		if r.Error != nil {
			return nil, r.Error
		}
		return r.Result, nil
	case <-s.closed:
		if s.readErr != nil {
			return nil, fmt.Errorf("the MCP stream ended: %w", s.readErr)
		}
		return nil, errors.New("the MCP stream ended before answering")
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (s *Session) notify(ctx context.Context, method string) error {
	return s.post(ctx, rpcRequest{JSONRPC: "2.0", Method: method})
}

func (s *Session) post(ctx context.Context, body rpcRequest) error {
	buf, err := json.Marshal(body)
	if err != nil {
		return err
	}
	url := s.endpoint
	if strings.HasPrefix(url, "/") {
		url = s.client.BaseURL + url
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(buf))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	s.client.decorate(req)
	// The POST itself is bounded by the client's timeout; the answer arrives on the stream.
	post := &http.Client{Timeout: s.client.timeout}
	resp, err := post.Do(req)
	if err != nil {
		return fmt.Errorf("posting %s: %w", body.Method, err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	// 202 is what the server answers when it took the message; the response comes later.
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("the MCP server refused %s: %s", body.Method, resp.Status)
	}
	return nil
}

// read consumes the stream: the first `endpoint` event is handed to Open, every `message`
// event is matched to a waiting call by id. Anything else is ignored.
func (s *Session) read(body io.Reader, endpoint chan<- string) {
	defer close(s.closed)
	sc := bufio.NewScanner(body)
	sc.Buffer(make([]byte, 0, 64<<10), maxEventBytes)
	var event, data string
	flush := func() {
		switch event {
		case "endpoint":
			select {
			case endpoint <- data:
			default:
			}
		case "message", "":
			var r rpcResponse
			if json.Unmarshal([]byte(data), &r) == nil && r.ID != nil {
				s.mu.Lock()
				ch, ok := s.waiting[*r.ID]
				s.mu.Unlock()
				if ok {
					ch <- r
				}
			}
		}
		event, data = "", ""
	}
	for sc.Scan() {
		line := sc.Text()
		switch {
		case line == "":
			if data != "" {
				flush()
			}
		case strings.HasPrefix(line, "event:"):
			event = strings.TrimSpace(line[len("event:"):])
		case strings.HasPrefix(line, "data:"):
			if data != "" {
				data += "\n"
			}
			data += strings.TrimSpace(line[len("data:"):])
		}
	}
	if data != "" {
		flush()
	}
	s.readErr = sc.Err()
	select {
	case endpoint <- "":
	default:
	}
}

func (c *Client) decorate(req *http.Request) {
	req.Header.Set("User-Agent", c.UserAgent)
	if c.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.APIKey)
	}
}
