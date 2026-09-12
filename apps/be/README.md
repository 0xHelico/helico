# Backend

`@helico/be`. Go. Three jobs: the session behind the dapp, the conversation that turns a sentence
into a checked swap intent, and the blog. Plus a cache in front of our subgraph, so a hundred
visitors asking the same question cost one query a minute.

## Run

```bash
cd apps/be
cp .env.example .env      # optional: a model key, if you want the conversation
go run ./cmd/be           # :8787
```

It creates `data/helico.db` and seeds every `content/*.md` the database does not already hold word
for word. `go build -o bin/be ./cmd/be` for a binary, no C toolchain, the SQLite driver is pure
Go.

`.env` is read for anything the environment does not set, and **the environment always wins**, so
a deployment is unaffected by a file it never has.

| Variable | Default | Meaning |
|---|---|---|
| `BE_ADDR` | `:8787` | listen address |
| `BE_DB_PATH` | `data/helico.db` | the SQLite file; its directory is created |
| `BE_ADMIN_TOKEN` | empty | bearer token for blog writes; empty refuses them with `503` |
| `BE_CORS_ORIGINS` | the four localhost ports | browser origins allowed in |
| `BE_CONTENT_DIR` | `content` | Markdown to seed from |
| `BE_REQUEST_TIMEOUT` | `30s` | one request, end to end; the whole chain of models has to fit inside it |
| `BE_SESSION_SECRET` | empty | signs the session cookie; empty keeps a generated key beside the database, so a restart no longer signs everyone out |
| `BE_LLM_API_KEY` | empty | **empty turns the conversation off**, with a `503` that says so |
| `BE_LLM_BASE_URL` | OpenAI | any OpenAI-compatible endpoint, which is what lets a router stand where the provider used to |
| `BE_LLM_MODEL` | `gpt-4o-mini` | the model asked for the swap JSON |
| `BE_LLM_USER` / `BE_LLM_PASS` | empty | HTTP basic credentials, for an endpoint behind a proxy challenge. When set, the key is sent as `X-Api-Key` instead: one `Authorization` header cannot carry Basic and Bearer at once, and the proxy answers first |
| `BE_LLM_FALLBACK_*` | empty | the same five variables for a second model, asked **only when the first fails**. Empty key means no fallback, which is one model rather than a broken one |
| `BE_LLM_TIMEOUT` | `12s` | one model, not the chain. `timeout × models` must be shorter than `BE_REQUEST_TIMEOUT`, or startup refuses it |
| `BE_SWAP_RATE_PER_MIN` / `BE_SWAP_DAILY_MAX` | `6` / `500` | what the paid model may cost |
| `BE_SUBGRAPH_URL` | Helico's Studio deployment | what `POST /api/graph` stands in front of |
| `BE_GRAPH_TTL` / `BE_GRAPH_RATE_PER_MIN` | `60s` / `120` | how long an answer is kept, and per-address reads |
| `BE_GRAPH_MCP_URL` | empty | **empty leaves the chat's index reads off.** The Graph's Subgraph MCP server: `https://subgraphs.mcp.thegraph.com` |
| `BE_GRAPH_MCP_SUBGRAPH_ID` | empty | Helico's subgraph id on The Graph Network — the MCP serves the network, not Studio, so this is set after publishing |
| `BE_GRAPH_MCP_API_KEY` | empty | sent as a Bearer token when set; the server answers without one |
| `BE_TELEGRAM_TOKEN` | empty | **empty means no bot and no webhook**: `POST /api/telegram/webhook` answers 404, because nothing exists to be unwell |
| `BE_TELEGRAM_SECRET` | empty | the value Telegram echoes in `X-Telegram-Bot-Api-Secret-Token`. A token with **no** secret refuses every caller rather than accepting every caller |
| `BE_TELEGRAM_RATE_PER_MIN` | `12` | per Telegram user, not per address: every update arrives from Telegram's own servers, so an IP-keyed bucket would be one bucket for everybody |
| `BE_GRAPH_MCP_TIMEOUT` | `40s` | one status question end to end: every model and MCP call together. The intent route gets this budget when the index is on |

## The model is a router, and there are two of them

`BE_LLM_BASE_URL` has always been any OpenAI-compatible endpoint, and that is the whole reason
[9router](https://github.com/decolua/9router) can stand where `api.openai.com` used to: the
request and the response are the same shape, and only the address, the key and the model string
change. Nothing in `internal/swap` knows which provider is behind it.

Two of them are configured, and the order is about **latency rather than preference**. Measured
on 12 September against this repository's own system prompt: the first answers in 1.3 to 2.2
seconds, the second in 6.3 to 7.1. Both answer correctly. So the quick one goes first and the
other is what the conversation falls back to when a router is down, which matters because they
are separate machines belonging to separate people.

Two things a second endpoint made necessary, and neither is optional:

**`stream: false` is stated rather than assumed.** It is the OpenAI default and not every
router's: one of ours answers `text/event-stream` unless told otherwise, and a stream of `data:`
chunks does not parse as the single object the client expects. The failure is a complaint about a
shape, which says nothing about the cause.

**Basic credentials are a header, never part of the URL.** A request that never connects comes
back as a `*url.Error`, which prints the URL it was given, so credentials in the userinfo end up
in every log and error string that value reaches.

What a caller can learn from all this is unchanged. `GET /api/swap/config` reports whether a model
is available and its family name — `gpt-4o-mini`, not the router's `fajar-openai/gpt-4o-mini`,
because the part before the slash names the account the call is billed to. A failure is logged
here and answered with one sentence that names no host. And `BE_SWAP_RATE_PER_MIN` with
`BE_SWAP_DAILY_MAX` is what stops the endpoint being a way to spend somebody else's money: the
address it counts is the one nginx writes, never a header a caller can forge.

## The Telegram bot, which cannot sign

`internal/telegram` answers read commands over the Bot API. **No private key reaches it and none
ever should.** Every safety argument in `contracts/` rests on two facts — the owner's wallet signs,
and the agent's reach is the owner's allowlist — and `HelicoAccount._requireOwnerOrAgent` admits
`owner()` or the nominated agent and nobody else. A Telegram process is neither, because one
compromised bot token would otherwise reach every account that ever talked to it. The most powerful
thing this code does is read public data and format it.

**A chat id is not an identity either.** This slice answers only about an address somebody types
into the chat, which is public whoever asks, so nothing here needs the signing bind #218 designs.
Group chats are refused anyway, so that is already true on the day a linked wallet's balances
become answerable.

```
/help                 what it is, and what it cannot do
/portfolio <address>  that owner's account: the total, and liquid against earning
/moves <address>      how often the agent has moved it, and when last
```

The reply is read from the chain — `accountFor` on the factory, then `balanceOf` on USDC and on
each market's receipt — and the move count comes from `internal/activity`, so it is the same
history the portfolio page shows rather than a second scan.

**Design and review are in [#218](https://github.com/0xHelico/helico/issues/218).** Its file layout
put the Bot API client in `packages/plugins/telegram`; that cannot work, because this is Go and
cannot consume a TypeScript package, so the client lives beside the handlers. Notifications and
composing an intent are the later tiers and are deliberately absent.

**Proven against the real chain with a fake Bot API**, which is what `TG_LIVE=1` exercised while it
was being written: `/portfolio` on the live owner returned `1.50 USDC · 1.50 liquid · 0.00 earning`
and `/moves` returned `2 times, last 11 Sep 2026 11:30 UTC`, both matching what the dapp shows.
**It has not been run against the live Bot API**, because that needs a bot token, which is not in
this repository — so nothing here should be described as tested end to end with Telegram itself
until it has been.

## The chat reads the index

With `BE_GRAPH_MCP_URL` and `BE_GRAPH_MCP_SUBGRAPH_ID` set, a `status` question — *"why has
nothing moved?"*, *"check my portfolio"* — is answered from the subgraph as well as from the
chain: the backend opens a session on The Graph's **Subgraph MCP** server, hands the model the
subgraph's schema, and lets it write GraphQL, up to five queries, against Helico's subgraph and
nothing else. What comes back is **one step per MCP call** under the answer, so the reads that
informed it are in the open. A failure adds a failed step and leaves the reply exactly what it
was; with the variables unset the code path is never entered.

The index's own sentence is the **last step**, `index.answer`, under the calls that produced it —
not a card. It was a card once and was dropped for reading as debug output (an address, a hash, a
timestamp for a question nobody asked); dropping it left the loop paying for model-written
queries and discarding the result, so it came back as a step (#455, #464): capped in code to two
sentences, every hash and full address cut to its ends, and told in the prompt what it must not
say — no balance the chain would answer differently, no claim about what the agent did, nothing
the page already shows.

That is two Graph products composed — the Subgraph and the MCP — and both load-bearing. Measured
before it was written: `docs/plans/2026-09-12-the-chat-reads-the-index.md`. The client is
`internal/graphmcp`; the loop is `Ask` in `internal/swap/ask.go`; the live tests
(`GRAPH_MCP_LIVE=1`) run the real server and the real model against a public subgraph.

## Routes

| Route | Auth | Answer |
|---|---|---|
| `GET /healthz` | | `{"status":"ok"}` |
| `GET /api/session/nonce` · `POST` · `GET` · `DELETE /api/session` | | sign in with a wallet signature, ask who you are, sign out |
| `GET`/`POST`/`DELETE /api/chats…` | session | conversations, scoped to the wallet that owns them |
| `POST /api/swap/intent` | | `{reply, action, intent, needs, steps}`; `503` with no model |
| `POST /api/graph` | | a cached subgraph read, same body and JSON as Studio, `X-Cache: hit\|miss` |
| `GET /api/posts` · `GET /api/posts/{slug}` | | the blog, keyset-paginated, `ETag` and `304` |
| `PUT` · `DELETE /api/posts/{slug}` | bearer | write the blog |

Errors are `application/problem+json`. JSON over 1 KiB is gzipped. Reads carry
`Cache-Control: public, max-age=60, stale-while-revalidate=300`.

## Three things worth knowing

**The session is a cookie, `SameSite=Lax` and `HttpOnly`.** `localhost` and `helico.site` are
different *sites*, so a local page pointed at `api.helico.site` signs in and is signed out by the
next reload, the cookie is set and never sent. Point both at localhost.

**`POST /api/graph` knows no GraphQL beyond the operation name.** The queries live in
[`@helico/plugin-thegraph`](../../packages/plugins/thegraph/); this forwards a body and remembers
the answer. Only `Mandates` and `Movements` are forwarded, or it would be an open proxy onto our
own rate limit. The cache is in memory, which is right for one process and wrong for two. The
only state is a hash of a request to an answer, which is where Redis would go.

**The model proposes; this checks.** Both symbols must resolve in a registry committed to
[`internal/swap/tokens.go`](internal/swap/tokens.go), whose addresses were read from Arbitrum One
with `symbol()` and `decimals()`, so an intent can never carry an address a model invented. The
amount must parse as a positive decimal within the token's decimals. The confirmation sentence is
composed here from the checked numbers, not by the model, so the two cannot disagree.

A comma is refused rather than read: it is the decimal point in Indonesian and the thousands
separator elsewhere, and guessing turns `0,5` into `5`. Limits on purpose: one chain, five assets,
exact-input only. `USDC.e` is absent because the bridged token is a different contract with its own
pools, and naming it is refused rather than resolved to the native one.

## Shape

```
cmd/be              wiring, signals, graceful shutdown
internal/config     BE_* variables, defaults, and the .env fallback
internal/session    the cookie, the nonce, the EIP-712 verifier
internal/graph      the subgraph cache
internal/swap       the token registry, the checks, the model client
internal/blog       Post, Draft validation, Markdown rendering, reading time, cursors
internal/store      SQLite: embedded migrations, prepared statements, one writer, WAL
internal/httpapi    routes, handlers, middleware
content/            the posts; the landing reads these too when it builds without the API
```

The standard library's router covers these routes and a framework would add more than it removes.
Rendering on write means a read is one indexed row. Keyset pagination keeps a deep page as cheap
as the first.

## Verify

```bash
go vet ./... && gofmt -l . && go test -race ./...
```

Every layer: validation and cursors, the store against a temporary database, seeding twice, the
handlers end to end with auth, `304`, pagination, gzip and CORS, and the cache proved by counting
what actually reached upstream.
