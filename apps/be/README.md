# Backend

`@helico/be`: Helico's AI side and its blog, in Go. Posts live in one SQLite file, seeded from
the Markdown in [`content/`](content/), and are served as JSON with the HTML already rendered.
The swap conversation turns a person's sentence into a swap intent the rest of the project can
act on; it never signs, sends, or quotes.

## Run

```
cd apps/be
BE_ADMIN_TOKEN=change-me go run ./cmd/be
```

Listens on `:8787`, creates `data/helico.db`, and seeds every `content/*.md` that the database
does not already hold word for word. `go build -o bin/be ./cmd/be` for a binary; it needs no C
toolchain, the SQLite driver is pure Go.

| Variable | Default | Meaning |
|---|---|---|
| `BE_ADDR` | `:8787` | listen address |
| `BE_DB_PATH` | `data/helico.db` | the SQLite file; its directory is created |
| `BE_ADMIN_TOKEN` | empty | bearer token for writes; empty refuses writes with `503` |
| `BE_CORS_ORIGINS` | `http://localhost:4321,http://localhost:4322` | browser origins allowed in |
| `BE_CONTENT_DIR` | `content` | Markdown to seed from; missing means no seeding |
| `BE_REQUEST_TIMEOUT` | `10s` | one request, end to end |
| `BE_LLM_API_KEY` | empty | **empty turns the swap conversation off**, with a `503` that says so |
| `BE_LLM_BASE_URL` | `https://api.openai.com/v1` | any OpenAI-compatible endpoint |
| `BE_LLM_MODEL` | `gpt-4o-mini` | the model asked for the swap JSON |
| `BE_LLM_TIMEOUT` | `8s` | one call to the model; must be shorter than `BE_REQUEST_TIMEOUT`, or startup refuses it |
| `BE_SWAP_RATE_PER_MIN` | `6` | swap messages one address may send per minute |
| `BE_SWAP_DAILY_MAX` | `500` | the process's ceiling on model calls per day |

## Routes

| Route | Auth | Answer |
|---|---|---|
| `GET /healthz` | | `{"status":"ok"}` |
| `GET /api/posts?limit=20&cursor=` | | `{items, next_cursor}`, newest first, keyset cursor, `ETag` |
| `GET /api/posts/{slug}` | | the post with `html` and `markdown`; `ETag`, `304` on `If-None-Match` |
| `PUT /api/posts/{slug}` | bearer | create (`201`) or replace (`200`) from `{title, summary, author, cover, tags, markdown, published_at}` |
| `DELETE /api/posts/{slug}` | bearer | `204` |
| `POST /api/swap/intent` | | `{reply, intent, needs}`; `503` when no model is configured |

Errors are `application/problem+json`. JSON above 1 KiB is gzipped when the client accepts it.
Reads carry `Cache-Control: public, max-age=60, stale-while-revalidate=300`.

```
curl -X PUT localhost:8787/api/posts/hello \
  -H 'Authorization: Bearer change-me' -H 'Content-Type: application/json' \
  -d '{"title":"Hello","author":"Helico","markdown":"# Hello\n\nA *post*."}'
```

## The swap conversation

```
curl -X POST localhost:8787/api/swap/intent \
  -H 'Content-Type: application/json' \
  -d '{"message":"swap half an ETH into USDC"}'
```

```json
{
  "reply": "Swapping 0.5 ETH into USDC on Arbitrum One. Nothing has moved: this is what I understood, and you sign it yourself.",
  "intent": {
    "chainId": 42161,
    "tokenIn":  { "symbol": "ETH",  "address": "0x0000…0000", "decimals": 18 },
    "tokenOut": { "symbol": "USDC", "address": "0xaf88…5831", "decimals": 6 },
    "amountIn": "0.5",
    "amountInWei": "500000000000000000"
  }
}
```

**The model proposes; this package checks.** Both symbols must resolve in a registry committed
to [`internal/swap/tokens.go`](internal/swap/tokens.go), whose addresses were read from
Arbitrum One with `symbol()` and `decimals()`, so an intent can never carry an address a model
invented. The amount must parse as a positive decimal within the token's decimals and convert
to base units exactly. Anything else comes back as a question or a refusal, with `intent: null`.

The confirmation sentence is composed here from the checked numbers, not by the model, so the
sentence and the intent cannot disagree.

Amounts are written with a dot. A comma is refused rather than read, because it is the decimal
point in Indonesian and the thousands separator elsewhere, and guessing turns `0,5` into `5`.

Known limits, on purpose: one chain (Arbitrum One), five assets, exact-input only. `USDC.e` is
absent: the bridged token is a different contract with its own pools, so naming it is refused
rather than resolved to the native one. "Buy 100
USDC with ETH" is answered with a question about how much ETH, because an exact-output swap is
a different request and this does not pretend to price anything.

## Shape

```
cmd/be              wiring, signals, graceful shutdown
internal/config     BE_* variables with defaults
internal/blog       the domain: Post, Draft validation, Markdown rendering, reading time, cursors
internal/store      SQLite: embedded migrations, prepared statements, one writer, WAL
internal/content    front-matter Markdown files → the store, skipping what is unchanged
internal/swap       the token registry, the checks, the model client, the conversation
internal/httpapi    routes, handlers, middleware (recover, request id, logs, CORS, gzip, timeout, rate limit)
content/            the posts; the landing reads these too when it builds without the API
```

Why these choices: the standard library's router covers five routes and a framework would add
more than it removes; rendering on write means a read is one indexed row; keyset pagination
keeps a deep page as cheap as the first; the front-matter files stay the source of truth so a
post is reviewed in a pull request like any other change.

## Verify

```
go vet ./... && gofmt -l . && go test -race ./...
```

Tests cover each layer: validation, rendering and cursors; the store against a temporary
database; seeding twice; the handlers end to end with auth, `304`, pagination, gzip and CORS.
Turborepo runs `go vet` and `go test` through `bun run typecheck` and `bun run test` at the root.

Written by an AI assistant with the author's direction; see [`AI-USAGE.md`](../../AI-USAGE.md).
