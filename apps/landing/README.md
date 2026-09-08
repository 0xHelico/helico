# @helico/landing

[helico.site](https://helico.site) — the marketing page and the blog. Astro 7.

One long page in four cards: a hero with an animated canvas, a "built on" logo grid, the mandate
shown field by field beside the line in the vault that enforces it, and verified-by-default facts
with a live tick. Then the FAQ and the footer.

The canvas is a React island cycling through four scripted scenarios — commit a mandate, re-centre
through the enclave, refuse tampered thresholds, hold while in range. Illustrative, but the
numbers in it are ones the repository actually recorded.

Plan: [`docs/plans/2026-09-06-landing-ui.md`](../../docs/plans/2026-09-06-landing-ui.md).

## Run

```bash
bun run --filter @helico/landing dev
bun run --filter @helico/landing build
bun run --filter @helico/landing typecheck   # astro check
```

## Where things are

| | |
|---|---|
| Page composition | `src/pages/index.astro` |
| Sections | `src/components/sections/*.astro` |
| Head, icons, metadata | `src/layouts/Base.astro`, `public/site.webmanifest` |
| The canvas island | `src/components/canvas/` — `HeroCanvas.tsx` is the frame |
| Scenarios | `canvas/cycles.ts` (chat), `canvas/provenance.ts` (stations) |
| Theme, cards, buttons | `src/styles/global.css` (Tailwind v4 `@theme`) |
| Served by | `nginx.conf` and `security-headers.conf` |

Brand logos go in `src/assets/brands/<slug>.svg`; the slugs are listed in `Brands.astro`, and a
name with no file renders as a wordmark. The grid lists only protocols, chains and the event this
repository actually touches — it is not a backers section, because Helico has none.

## Things that will bite

- **Biome skips `.astro` files and `public/`.** The island's `.tsx` and the CSS are checked; the
  templates are not.
- **The security headers are in their own file** and `include`d three times. nginx discards every
  inherited `add_header` in a `location` that sets one of its own, so a location that wants a
  `Cache-Control` silently loses the CSP. `scripts/check-nginx-headers.py` fails if one forgets.
- **The island is `client:visible`**, so React and framer-motion (~340 KB) load only when the
  section approaches.

## Blog

`/blog` is built from one source of truth — the Markdown in [`apps/be/content`](../be/content) —
through the backend's API when `BE_URL` is set and it answers, and straight from the files
otherwise. The build log says which: `[blog] 4 posts from the api|files`.

```bash
BE_URL=http://127.0.0.1:8787 bun run build
```
