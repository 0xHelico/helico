package swap

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/0xHelico/helico/apps/be/internal/graphmcp"
)

// Index is the subgraph the chat may read, through The Graph's Subgraph MCP server.
//
// This is the second Graph product the application composes with its Subgraph, and the reason
// it is a separate type with a separate loop is the honesty property `Interpret` keeps: there,
// every sentence a person reads is composed by this package from checked numbers. Here the model
// composes the sentence, from numbers it read out of the index — so the sentence is labelled as
// the model's, and every query that produced it is returned as a step beside it. What the
// model cannot do is run anything but a GraphQL read against one pinned subgraph.
type Index struct {
	MCP        *graphmcp.Client
	SubgraphID string
	// MaxQueries bounds the loop. Six is enough for "which of my mandates still have money in
	// them" — schema, accounts, mandates, balances — and small enough that a model going in
	// circles costs a few seconds rather than a minute.
	MaxQueries int
	// Timeout bounds the whole question: every model call and every MCP call together.
	Timeout time.Duration
	// ModelTimeout bounds one model call inside the loop. The intent's own model timeout is
	// sized for a one-line JSON answer; a turn here carries a schema and a result, and thinking
	// models take longer over it.
	ModelTimeout time.Duration
	// SchemaTTL is how long the schema read through MCP is kept. A subgraph's schema changes
	// only when it is redeployed, so minutes are fine and a process restart is a clean read.
	SchemaTTL time.Duration

	mu         sync.Mutex
	schema     string
	schemaRead time.Time
}

// Configured reports whether questions can be asked at all.
func (i *Index) Configured() bool {
	return i != nil && i.MCP.Configured() && i.SubgraphID != ""
}

// IndexAnswer is what Ask produced: the model's sentence and what it read to write it.
type IndexAnswer struct {
	// Answer is the model's, composed from the query results. It is shown as the model's.
	Answer string
	// Queries is how many GraphQL reads ran, which the card names so the person knows the
	// sentence came from somewhere.
	Queries int
	// Server is what the MCP server called itself in the handshake.
	Server string
}

// maxResultBytes bounds what one query result may hand back to the model. A model that asked
// for `first: 1000` gets the first part and a note, not a context window full of ids.
const maxResultBytes = 8 << 10

// askPrompt is the instruction for the read loop. The schema is appended at runtime.
const askPrompt = `You are the part of Helico's chat that reads the index. Everything is on Arbitrum One.

Helico gives a person a smart-contract account of their own; an agent running in a Chainlink CRE
enclave may move that account's idle capital between lending markets the owner allow-listed, and
nothing else. A subgraph (The Graph) indexes 1inch Aqua — makers, mandates (strategies), the
ledger balances behind them, fills — and Helico's own account factory. You reach that subgraph
through one tool: a GraphQL query, executed by The Graph's Subgraph MCP server.

You answer ONE question from the person, using ONLY what the index returns. Work in turns. Each
turn, answer with JSON only, one of these two shapes:

  {"query": "<a GraphQL query>", "variables": {}, "why": "<one short line: what this read is for>"}
  {"answer": "<the reply, in plain sentences>"}

Rules:
- Read the schema below before the first query. Query only entities and fields that exist in it.
- Addresses in the index are lowercase hex. Compare and filter with lowercase.
- Ask for small pages ("first: 20") and only the fields you need. Results are truncated past a
  few kilobytes, and a truncated result is a wasted turn.
- Amounts are raw token units unless a field says otherwise. USDC and USDT have 6 decimals; WETH
  and most others have 18. When you show an amount, show it converted and name the token; when
  you cannot tell the decimals, show the raw number and say it is raw.
- If the index returns an error, read it, fix the query once, and if it fails again say what
  you could not read. Never invent a number, a date, or a name.
- Answer in at most five plain sentences. No headings, no bullet points, no markdown. Say
  where the answer came from in a few words ("the index shows…"). If the question is not
  something the index can answer — a price, a prediction, an instruction to move money — say so
  in one sentence and stop.
- You have at most %d queries. Answer as soon as you know.`

// chatTurn is one model exchange the loop keeps, so the model sees what it asked and what came back.
type chatTurn = chatMessage

// Ask answers one question from the index. `owner` is the person's wallet, lowercase, or empty
// when the app did not send one — the model is told which. The steps returned are one per MCP
// call, in order, for the app to draw under the answer.
func (s *Service) Ask(ctx context.Context, idx *Index, question, owner string) (IndexAnswer, []Step, error) {
	if !s.Configured() {
		return IndexAnswer{}, nil, ErrNotConfigured
	}
	if !idx.Configured() {
		return IndexAnswer{}, nil, graphmcp.ErrNotConfigured
	}
	timeout := idx.Timeout
	if timeout <= 0 {
		timeout = 45 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	maxQ := idx.MaxQueries
	if maxQ <= 0 {
		maxQ = 6
	}

	session, err := idx.MCP.Open(ctx)
	if err != nil {
		return IndexAnswer{}, []Step{{Call: "mcp.open", Detail: err.Error(), OK: false}}, err
	}
	defer session.Close()
	steps := []Step{{Call: "mcp.initialize", Detail: session.Server, OK: true}}

	schema, err := idx.schemaFor(ctx, session)
	if err != nil {
		steps = append(steps, Step{Call: "mcp." + graphmcp.ToolSchemaBySubgraphID, Detail: err.Error(), OK: false})
		return IndexAnswer{}, steps, err
	}
	steps = append(steps, Step{Call: "mcp." + graphmcp.ToolSchemaBySubgraphID, Detail: fmt.Sprintf("%d bytes of schema", len(schema)), OK: true})

	whose := "The person did not connect a wallet, so you do not know which account is theirs; answer about the index in general and say that."
	if owner != "" {
		whose = "The person's wallet is " + owner + ". Their Helico account, if they opened one, is the account whose owner is that address."
	}
	msgs := []chatTurn{
		{Role: "system", Content: fmt.Sprintf(askPrompt, maxQ) + "\n\n" + whose + "\n\nThe subgraph's schema:\n\n" + schema},
		{Role: "user", Content: question},
	}

	// A copy of the model client with this loop's own per-call timeout; the intent's client is
	// untouched.
	model := *s.client
	if idx.ModelTimeout > 0 {
		model.HTTP = &http.Client{Timeout: idx.ModelTimeout}
	}

	queries := 0
	for turn := 0; turn <= maxQ; turn++ {
		raw, _, err := model.complete(ctx, msgs)
		if err != nil {
			steps = append(steps, Step{Call: "model", Detail: err.Error(), OK: false})
			return IndexAnswer{}, steps, err
		}
		var reply struct {
			Query     string          `json:"query"`
			Variables json.RawMessage `json:"variables"`
			Why       string          `json:"why"`
			Answer    string          `json:"answer"`
		}
		if err := json.Unmarshal([]byte(raw), &reply); err != nil {
			steps = append(steps, Step{Call: "model", Detail: "answered with something that was not the shape asked for", OK: false})
			return IndexAnswer{}, steps, fmt.Errorf("the model's answer was not the shape asked for: %w", err)
		}
		if strings.TrimSpace(reply.Answer) != "" {
			return IndexAnswer{Answer: strings.TrimSpace(reply.Answer), Queries: queries, Server: session.Server}, steps, nil
		}
		if strings.TrimSpace(reply.Query) == "" {
			steps = append(steps, Step{Call: "model", Detail: "answered with neither a query nor an answer", OK: false})
			return IndexAnswer{}, steps, errors.New("the model answered with neither a query nor an answer")
		}
		if queries >= maxQ {
			steps = append(steps, Step{Call: "model", Detail: fmt.Sprintf("asked for a %dth query; the limit is %d", queries+1, maxQ), OK: false})
			return IndexAnswer{}, steps, errors.New("the model ran out of queries without answering")
		}
		queries++

		args := map[string]any{"subgraph_id": idx.SubgraphID, "query": reply.Query}
		if len(reply.Variables) > 0 && string(reply.Variables) != "null" {
			var vars map[string]any
			if json.Unmarshal(reply.Variables, &vars) == nil && len(vars) > 0 {
				args["variables"] = vars
			}
		}
		res, err := session.Call(ctx, graphmcp.ToolExecuteBySubgraphID, args)
		detail := firstLine(reply.Query)
		if reply.Why != "" {
			detail = reply.Why + " — " + detail
		}
		msgs = append(msgs, chatTurn{Role: "assistant", Content: raw})
		switch {
		case err != nil:
			steps = append(steps, Step{Call: "mcp." + graphmcp.ToolExecuteBySubgraphID, Detail: detail + " → " + err.Error(), OK: false})
			msgs = append(msgs, chatTurn{Role: "user", Content: "The index refused that query: " + err.Error()})
		default:
			ok := !res.IsError && !strings.Contains(res.Text, `"errors"`)
			steps = append(steps, Step{Call: "mcp." + graphmcp.ToolExecuteBySubgraphID, Detail: detail, OK: ok})
			msgs = append(msgs, chatTurn{Role: "user", Content: "Result:\n" + truncate(res.Text, maxResultBytes)})
		}
	}
	return IndexAnswer{}, steps, errors.New("the model ran out of turns without answering")
}

// schemaFor reads the subgraph's schema through MCP, keeping it for SchemaTTL.
func (i *Index) schemaFor(ctx context.Context, session *graphmcp.Session) (string, error) {
	ttl := i.SchemaTTL
	if ttl <= 0 {
		ttl = 10 * time.Minute
	}
	i.mu.Lock()
	if i.schema != "" && time.Since(i.schemaRead) < ttl {
		s := i.schema
		i.mu.Unlock()
		return s, nil
	}
	i.mu.Unlock()

	res, err := session.Call(ctx, graphmcp.ToolSchemaBySubgraphID, map[string]any{"subgraph_id": i.SubgraphID})
	if err != nil {
		return "", err
	}
	if res.IsError || strings.TrimSpace(res.Text) == "" {
		return "", fmt.Errorf("the index has no schema for %s", i.SubgraphID)
	}
	i.mu.Lock()
	i.schema, i.schemaRead = res.Text, time.Now()
	i.mu.Unlock()
	return res.Text, nil
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i] + " …"
	}
	if len(s) > 120 {
		s = s[:120] + "…"
	}
	return s
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "\n… (truncated; ask for a smaller page)"
}
