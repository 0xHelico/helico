# A blog for the landing, and a backend to serve it

Tracked in #73. Branch `feat/blog`, stacked on the landing branch (#67) because the blog pages
live in the same Astro app.

## Prompt, verbatim in translation

> "Make the blog too, while you are at it. Example blog UI: [a Medium article]. And build the
> backend in `apps/be` with Go and a local SQLite database; make it as optimised and efficient as
> possible, and make sure it is clean code, professional patterns, modular, and performant. You
> may use a framework or anything."

An earlier instruction kept `apps/be` off limits; this one lifts it.

## What is built

**A backend, `apps/be`, in Go.** Standard library `net/http` with the 1.22 route patterns, no
framework: the surface is five routes and a framework would add more code than it removes.
SQLite through `modernc.org/sqlite` (pure Go, so `go build` needs no C toolchain), WAL mode, a
busy timeout, and one writer at a time. Markdown is rendered once, on write, with `goldmark`
(GFM tables and strikethrough, typographer), and the HTML is stored next to the source, so a read
is one indexed row and no rendering. Reading time is computed on write too.

```
apps/be/
  cmd/be/main.go          wiring and graceful shutdown
  internal/config         environment, with defaults
  internal/blog           the domain: Post, validation, rendering, reading time
  internal/store          SQLite: embedded migrations, prepared statements, keyset pagination
  internal/content        seeds the store from content/*.md (front matter) on boot
  internal/httpapi        routes, handlers, middleware, JSON and problem+json helpers
  content/*.md            the posts, the source of truth
```

| Route | Auth | What |
|---|---|---|
| `GET /healthz` | no | liveness |
| `GET /api/posts?limit=&cursor=` | no | list, newest first, keyset cursor, `ETag` |
| `GET /api/posts/{slug}` | no | one post with rendered HTML, `ETag`, `304` on match |
| `PUT /api/posts/{slug}` | bearer `BE_ADMIN_TOKEN` | create or replace from Markdown |
| `DELETE /api/posts/{slug}` | bearer | remove |

Middleware, outermost first: recover, request id, structured logging (`log/slog`), CORS for
the configured origins, gzip for JSON above 1 KB. Timeouts on the server and per request.
Errors are `application/problem+json`. Configuration is environment only: `BE_ADDR`,
`BE_DB_PATH`, `BE_ADMIN_TOKEN`, `BE_CORS_ORIGINS`, `BE_CONTENT_DIR`.

Tests at every layer with the standard `testing` package and `httptest`: the store against a
temporary database, the domain's rendering and validation, the handlers end to end including
auth, `304`, and pagination. `go vet`, `gofmt -l`, and `go test ./...` run in CI; a tiny
`package.json` lets Turborepo run the same through `bun run typecheck` and `bun run test`.

**The blog, in `apps/landing`.** Two routes, `/blog` and `/blog/<slug>`, in the style of the
reference article, measured on it: the title 42px/700 with a 22px grey subtitle, an author row
with a 48px avatar and a 14px date and reading time, a 680px column, body text in a serif at
20px on 32px lines, section headings 24px/600, lists indented 30px. The reference's serif is
proprietary; Source Serif 4 stands in. Inter stays for headings and the chrome, and the nav and
footer are the landing's.

Where the posts come from at build time: the API when `BE_URL` is set (a build against a running
backend), otherwise the same Markdown files through an Astro content collection whose base is
`apps/be/content`. One source of truth, two readers; CI builds the fallback, a local build with
the backend running exercises the API. Recorded in the landing README.

**The posts.** Four to start, every one written from what the repository records: what Helico
is, the seven fields and what each refuses, why the swap is inside the vault, and the forwarder
path rehearsed on a fork. Author "Helico"; no cover images, a gradient banner instead.

## How it is verified

- `go vet ./...`, `gofmt -l .` empty, `go test ./...` in `apps/be`; the server started and
  every route exercised with `curl`, including a `PUT` with the token and a `304`.
- `astro check`, `astro build` twice: without `BE_URL` (files) and with the backend running
  (API), the same HTML either way apart from the source note.
- The Playwright audit extended to `/blog` and one article: overflow at seven viewports, axe.
