package swap

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
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
	// Trace, when set, receives every query sent and every result received, untruncated. For
	// the live test and for a debug log; nil in production.
	Trace func(kind, text string)

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

What this index holds, and what it does not — so you neither invent nor over-read:
- accounts: Helico accounts opened through the factory (owner, openedAt, openedTx). A person's
  account is accounts(where:{owner: <their wallet>}); the account has its own address (id).
- makers, mandates, balances, movements: 1inch Aqua — a maker is a wallet OR a Helico account
  that shipped a mandate; a mandate is one strategy with its ledger balances (the three-state
  sentinel: live, empty, docked) and the pulls and pushes against it. fills: swaps a taker
  executed against a maker, with taker, tokens and amounts.
- NOT here: the agent's own moves of idle capital into lending markets (supplyIdle /
  withdrawIdle), lending balances, rates, prices. When the question is about whether or why
  something "moved", your answer MUST contain this sentence, verbatim: "The agent's moves into
  lending markets are not in this index; the portfolio above reads those from the chain." Then
  say what the index does show (the account and when it was opened, its mandates, its fills).
  Never conclude "nothing moved" or "no transactions" from the absence of fills — a fill is a
  taker trading against a mandate, not a move of capital.
- When a wallet is given, ALWAYS read the index before answering — never answer with zero
  queries. Start from accounts(where:{owner: <wallet>}) and maker(id: <wallet>); the Helico
  account's own address is also a possible maker id. Check those before concluding.
- Timestamps are unix seconds. Convert them to a UTC date and time when you show them.

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
- State only what a query returned. Do not say "there are no fills" unless you asked for fills
  and got none. Do not report a count from a page you limited: "first: 1" tells you nothing
  about how many exist — fetch "first: 1000" and count, or say "at least N".
- The answer is shown as one line under the reads that produced it, so it is at most TWO
  sentences, plain text: no headings, no bullets, no markdown, no first person, no hedging
  about your own abilities. Give the concrete things you found — counts as counts, dates as
  dates — rather than a summary word. If the question is not something the index can answer —
  a price, a prediction, an instruction to move money — say so in one sentence and stop.
- Never write a transaction hash or a full address; refer to an account or a mandate by its
  shortened form ("0x0acd…4a39") and only when it is needed to tell two apart.
- Never give a balance or a holding — the index does not hold them and the page reads them
  from the chain; two figures on one screen with nothing to say which is right is worse than
  one. Never say when the account was opened unless the question asks for it; the page already
  links the opening transaction.
- Do not restate what the page already shows ("you have a Helico account at…"). Say only what
  the index adds.
- You have at most %d queries. Answer as soon as you know. An answer is final: after it you
  cannot query again, so never write "I will now check…" — check first, then answer.`

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
	nudged := false
	for turn := 0; turn <= maxQ+1; turn++ {
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
			// An answer that read nothing, about a person whose wallet is known, is the model
			// answering from the prompt. Sent back once with the read it should have made; a
			// second such answer is accepted, and the card's "0 queries" says what it is.
			if queries == 0 && owner != "" && !nudged {
				nudged = true
				msgs = append(msgs, chatTurn{Role: "assistant", Content: raw})
				msgs = append(msgs, chatTurn{Role: "user", Content: "You answered without reading the index. Read it first: at least accounts(where:{owner:\"" + owner + "\"}) and maker(id:\"" + owner + "\"), then answer with what you found — including when you found nothing."})
				continue
			}
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

		query := wrapQuery(reply.Query)
		// A root field with no subfields — `{ accounts(where:{…}) }` — comes back from the
		// gateway as `{}`, which a model reads as "nothing there". Refused here, before the
		// index is asked, with the reason the model can act on.
		if selectsNoFields(query) {
			steps = append(steps, Step{Call: "mcp." + graphmcp.ToolExecuteBySubgraphID, Detail: firstLine(query) + " → selected no fields; not sent", OK: false})
			msgs = append(msgs, chatTurn{Role: "assistant", Content: raw})
			msgs = append(msgs, chatTurn{Role: "user", Content: "That query selects no fields, so it would return nothing. Add a selection set, for example `{ id owner openedAt }`, and send it again."})
			continue
		}
		queries++
		args := map[string]any{"subgraph_id": idx.SubgraphID, "query": query}
		if len(reply.Variables) > 0 && string(reply.Variables) != "null" {
			var vars map[string]any
			if json.Unmarshal(reply.Variables, &vars) == nil && len(vars) > 0 {
				args["variables"] = vars
			}
		}
		if idx.Trace != nil {
			idx.Trace("query", query)
		}
		res, err := session.Call(ctx, graphmcp.ToolExecuteBySubgraphID, args)
		detail := firstLine(query)
		if reply.Why != "" {
			detail = reply.Why + " — " + detail
		}
		msgs = append(msgs, chatTurn{Role: "assistant", Content: raw})
		switch {
		case err != nil:
			steps = append(steps, Step{Call: "mcp." + graphmcp.ToolExecuteBySubgraphID, Detail: detail + " → " + err.Error(), OK: false})
			msgs = append(msgs, chatTurn{Role: "user", Content: "The index refused that query: " + err.Error()})
		default:
			if idx.Trace != nil {
				idx.Trace("result", res.Text)
			}
			ok := !res.IsError && !strings.Contains(res.Text, `"errors"`)
			steps = append(steps, Step{Call: "mcp." + graphmcp.ToolExecuteBySubgraphID, Detail: detail, OK: ok})
			msgs = append(msgs, chatTurn{Role: "user", Content: "Result:\n" + truncate(res.Text, maxResultBytes) + timeLegend(res.Text)})
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

// Sentence caps the answer the way the prompt asked for it, because a prompt is a request and
// this line is what a person reads: whitespace folded, markdown markers dropped, any hex string
// of forty or more digits cut to its ends, and no more than two sentences. The clause the demo
// question needs — "not in this index" — survives all of it.
func Sentence(answer string) string {
	t := strings.Join(strings.Fields(answer), " ")
	t = strings.NewReplacer("**", "", "`", "", "# ", "", "- ", "").Replace(t)
	t = longHex.ReplaceAllStringFunc(t, func(h string) string { return h[:6] + "…" + h[len(h)-4:] })
	// Two sentences: cut after the second terminal punctuation that is followed by a space or
	// the end. "2026-09-10 at 17:58:38 UTC." counts once; "e.g." would count, and is not a
	// phrase the prompt produces.
	count := 0
	for i := 0; i < len(t); i++ {
		if t[i] != '.' && t[i] != '!' && t[i] != '?' {
			continue
		}
		if i+1 < len(t) && t[i+1] != ' ' {
			continue
		}
		count++
		if count == 2 {
			return strings.TrimSpace(t[:i+1])
		}
	}
	return strings.TrimSpace(t)
}

// longHex is a transaction hash or an address: 0x and forty or more hex digits.
var longHex = regexp.MustCompile(`0x[0-9a-fA-F]{40,}`)

// wrapQuery gives a bare selection its braces. Smaller models write
// `accounts(where:{…}) { id }` and the gateway answers "Expected {, query, mutation…" — twice,
// because the retry looks the same to them. The fix is mechanical, so it is made here rather
// than asked for.
func wrapQuery(q string) string {
	t := strings.TrimSpace(q)
	for _, prefix := range []string{"{", "query", "mutation", "subscription", "fragment"} {
		if strings.HasPrefix(t, prefix) {
			return t
		}
	}
	return "{ " + t + " }"
}

// firstLine collapses a query to one line for the step under the answer — the whole query,
// whitespace folded, so the reader sees what was asked and not just its first line.
// selectsNoFields reports a query whose root selection has no subfields: after the outer
// braces there is no `{` left. `{ _meta { block { number } } }` has one; `{ accounts(where:{…}) }`
// has one too — inside the argument — so braces inside parentheses are skipped first.
func selectsNoFields(query string) bool {
	t := strings.TrimSpace(query)
	if !strings.HasPrefix(t, "{") {
		return false // a named operation; let the gateway judge it
	}
	inner := strings.TrimSuffix(strings.TrimPrefix(t, "{"), "}")
	depth := 0
	for _, c := range inner {
		switch c {
		case '(':
			depth++
		case ')':
			if depth > 0 {
				depth--
			}
		case '{':
			if depth == 0 {
				return false
			}
		}
	}
	return true
}

func firstLine(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > 200 {
		s = s[:200] + "…"
	}
	return s
}

// timeLegend lists every unix timestamp in a result with its UTC date, because a model asked
// to convert 1789063118 answers a date in the wrong year with full confidence. The arithmetic
// is done here and handed over; the model only has to copy it.
func timeLegend(text string) string {
	seen := map[string]bool{}
	var lines []string
	for _, m := range unixSeconds.FindAllStringSubmatch(text, -1) {
		v := m[1]
		if seen[v] {
			continue
		}
		seen[v] = true
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			continue
		}
		lines = append(lines, v+" = "+time.Unix(n, 0).UTC().Format("2006-01-02 15:04:05 UTC"))
		if len(lines) == 20 {
			break
		}
	}
	if len(lines) == 0 {
		return ""
	}
	return "\n\nTimestamps in this result, as UTC dates (use these, do not compute your own):\n" + strings.Join(lines, "\n")
}

// unixSeconds matches a quoted or bare 10-digit number in the 2020–2036 range, which is what a
// subgraph's BigInt timestamps look like in JSON.
var unixSeconds = regexp.MustCompile(`"?\b(1[6-9][0-9]{8}|20[0-9]{8})\b"?`)

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "\n… (truncated; ask for a smaller page)"
}
