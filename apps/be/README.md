# Backend

`@helico/be`: the blog's API, in Go. Posts live in one SQLite file, seeded from the Markdown
in [`content/`](content/), and are served as JSON with the HTML already rendered.

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

## Routes

| Route | Auth | Answer |
|---|---|---|
| `GET /healthz` | | `{"status":"ok"}` |
| `GET /api/posts?limit=20&cursor=` | | `{items, next_cursor}`, newest first, keyset cursor, `ETag` |
| `GET /api/posts/{slug}` | | the post with `html` and `markdown`; `ETag`, `304` on `If-None-Match` |
| `PUT /api/posts/{slug}` | bearer | create (`201`) or replace (`200`) from `{title, summary, author, cover, tags, markdown, published_at}` |
| `DELETE /api/posts/{slug}` | bearer | `204` |

Errors are `application/problem+json`. JSON above 1 KiB is gzipped when the client accepts it.
Reads carry `Cache-Control: public, max-age=60, stale-while-revalidate=300`.

```
curl -X PUT localhost:8787/api/posts/hello \
  -H 'Authorization: Bearer change-me' -H 'Content-Type: application/json' \
  -d '{"title":"Hello","author":"Helico","markdown":"# Hello\n\nA *post*."}'
```

## Shape

```
cmd/be              wiring, signals, graceful shutdown
internal/config     BE_* variables with defaults
internal/blog       the domain: Post, Draft validation, Markdown rendering, reading time, cursors
internal/store      SQLite: embedded migrations, prepared statements, one writer, WAL
internal/content    front-matter Markdown files → the store, skipping what is unchanged
internal/httpapi    routes, handlers, middleware (recover, request id, logs, CORS, gzip, timeout)
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
