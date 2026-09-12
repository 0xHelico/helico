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
| `BE_REQUEST_TIMEOUT` | `10s` | one request, end to end |
| `BE_SESSION_SECRET` | empty | signs the session cookie; empty keeps a generated key beside the database, so a restart no longer signs everyone out |
| `BE_LLM_API_KEY` | empty | **empty turns the conversation off**, with a `503` that says so |
| `BE_LLM_BASE_URL` | OpenAI | any OpenAI-compatible endpoint |
| `BE_LLM_MODEL` | `gpt-4o-mini` | the model asked for the swap JSON |
| `BE_LLM_TIMEOUT` | `8s` | must be shorter than `BE_REQUEST_TIMEOUT`, or startup refuses it |
| `BE_SWAP_RATE_PER_MIN` / `BE_SWAP_DAILY_MAX` | `6` / `500` | what the paid model may cost |
| `BE_SUBGRAPH_URL` | Helico's Studio deployment | what `POST /api/graph` stands in front of |
| `BE_GRAPH_TTL` / `BE_GRAPH_RATE_PER_MIN` | `60s` / `120` | how long an answer is kept, and per-address reads |

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
