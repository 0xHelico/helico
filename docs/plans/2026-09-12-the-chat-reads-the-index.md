# The chat reads the index: Subgraph MCP as a second Graph product

12 September 2026. Written before the code, as `CLAUDE.md` requires.

## Why now

The Graph offers two prizes at ETHOnline and their requirements differ. *Best AI Tooling or AI Use
Case* asks for one load-bearing use of live Graph data with reasoning, decisions, automation or a
natural-language interface on top — which the enclave's buffer sizing and the chat already are.
*Best Use of Composable or Standardized Graph Products* asks to *"compose two or more of The
Graph's products"* and says in as many words that *"simply querying one Subgraph with no
composition or standardization does not qualify."* We have one product. Ghoza's decision is to
submit for both, which means the second has to be real.

The chat today never sees data. The model classifies a sentence into one of eight actions and the
application composes every sentence a person reads from the registry or from checked numbers —
that is a deliberate honesty property (`apps/be/internal/swap/llm.go`, the comment above
`systemPrompt`), and nothing below weakens it. *"Why has nothing moved?"* is answered by a card
that points at the portfolio page. The index knows the answer; the chat does not ask it.

## What is being claimed, and what is not

**Claimed:** the chat composes two Graph products — our Subgraph, and The Graph's **Subgraph MCP**
server — and both are load-bearing: a question about a position is answered from the index, by a
model that reads the schema and writes the query through MCP, and every call it makes is shown
to the person as a step.

**Not claimed:** that the enclave uses MCP (it cannot; a TEE handler has HTTP, not SSE, and it
keeps its direct GraphQL read), that the model's sentence is checked the way a swap amount is (it
is labelled as the model's, with the queries that produced it beside it), or that this qualifies
anything — that is the judges'.

## Measured before writing any of this

Against `https://subgraphs.mcp.thegraph.com`, 12 September, no API key:

- `GET /sse` answers `200 text/event-stream` and an `endpoint` event naming
  `/messages?sessionId=…` — the 2024-11-05 MCP SSE transport. A Python `urllib` client gets 403
  until it sends a browser-like `User-Agent`; `curl` does not.
- `initialize` → `serverInfo {name: "subgraph-mcp", version: "0.1.1"}`, protocol `2024-11-05`.
  `tools/list` → nine tools: `search_subgraphs_by_keyword(keyword)`,
  `get_top_subgraph_deployments(chain, contract_address)`, `get_schema_by_subgraph_id`,
  `get_schema_by_ipfs_hash`, `get_schema_by_deployment_id`, `execute_query_by_subgraph_id(query,
  subgraph_id, variables)`, `execute_query_by_ipfs_hash`, `execute_query_by_deployment_id`,
  `get_deployment_30day_query_counts`.
- `execute_query_by_subgraph_id` on *Aave V3 Arbitrum* (`4xyasjQeREe7PxnF6wVdobZvCw5mhoHZq3T7guRpuNPf`,
  found by keyword) returns `_meta.block.number 504345891` **without a key**. The docs describe a
  Gateway API key as a Bearer header; the server accepts calls without one. The client sends the
  header when a key is configured and works either way.
- `execute_query_by_ipfs_hash` on our Studio deployment `QmbhmRoR9C…` answers *"subgraph not
  found"*, and `get_top_subgraph_deployments(arbitrum-one, Aqua)` answers an empty list. **The MCP
  serves the network, not Studio.** The one prerequisite outside this repository is publishing
  the subgraph to The Graph Network from Studio — Ghoza's, in the browser — after which the
  subgraph id goes into config and nothing else changes.

## Design

**`apps/be/internal/graphmcp`** — a client for the SSE transport, small enough to read: open the
stream, wait for `endpoint`, `initialize`, `notifications/initialized`, then `tools/call` with
JSON-RPC ids matched to the events that come back. One session per question, closed when the
question is answered; a session that dies mid-question is an error, not a retry. A `Fake` in the
test file implements the same two endpoints over `httptest`, so every test runs without the
network, and one integration test — skipped unless `GRAPH_MCP_LIVE=1` — asks the real server the
Aave question above.

**`apps/be/internal/swap` — `Ask`.** A second, separate loop beside `Interpret`, used only when
the action is `status` and the feature is configured. The model gets the subgraph's schema (read
once through MCP, cached for the process), the owner's address when the app sent one, and one
instruction: answer the question with numbers from the index, or say what you could not find.
Each turn it returns JSON — either `{"query": "...", "variables": {...}}` to run or
`{"answer": "..."}` to finish — the same `json_object` contract `Interpret` already relies on, so
it works with any provider that speaks it. Guards: at most six queries per question, read-only
by construction (the MCP tool executes GraphQL, and a GraphQL query has no mutations in a
subgraph), the subgraph id pinned from config so the model cannot point the tool elsewhere, a
timeout for the whole loop, and a hard cap on the bytes of each result handed back.

**What the person sees.** `Answer.Cards` gains one card, titled *From the index*, whose body is
the model's sentence, tagged `The Graph`, `Subgraph MCP`, and `n queries`; `Answer.Steps` gains
one step per MCP call — `mcp.execute_query_by_subgraph_id` with the query's first line — so the
tree the app already draws under every answer is the provenance. Nothing in the app has to
change for either: cards and steps are rendered today.

**One optional field, end to end.** The chat sends the connected wallet as `address` when there
is one (`chat.tsx` → `/api/chat` → `/api/swap/intent`). Absent, the model is told it does not
know whose account is being asked about and answers about the index in general. Every existing
caller keeps working unchanged.

**Configuration, all new, all optional.** `BE_GRAPH_MCP_URL` (empty = feature off, the default),
`BE_GRAPH_MCP_SUBGRAPH_ID` (the network id after publishing), `BE_GRAPH_MCP_API_KEY` (sent as
Bearer when set), `BE_GRAPH_MCP_TIMEOUT`. With the URL empty the code path is never entered and
`Interpret` is byte-for-byte what it was.

## What this does not touch

`Interpret`, its prompt, the registry checks, the `/api/graph` cache, the enclave, the subgraph,
the contracts. The swap path is not in the loop at all: `Ask` runs after `Interpret` has chosen
`status`, and a failure inside it removes the card and adds a failed step rather than changing
the reply.

## Order

1. This plan.
2. `graphmcp` client + fake + tests.
3. `Ask` loop + tests with a fake model and the fake MCP.
4. Wiring: config, service, the `address` field in the app's chat route and component.
5. Live test against the real MCP with a public subgraph (Aave) to prove transport and loop.
6. Ghoza publishes the subgraph; set the id and URL in Coolify; ask the live chat *"why has
   nothing moved?"* and read the steps.
7. `docs/tracks/thegraph.md`, `AI-USAGE.md`.
