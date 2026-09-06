# @helico/landing

The landing page, Astro 7. Hover menus in the nav (a sheet on small screens), then a long single page in four cards: the hero with the canvas, a
"built on" logo grid, the mandate (dark, one row per field with the line in the vault that
enforces it), build (with the vault's range check rendered from source), verified-by-default
facts with a live tick, then the FAQ, a stay-updated card, and the footer.

Logos for the grid go in `src/assets/brands/<slug>.svg` (png and webp work too); the slugs are
listed in `Brands.astro`, and a name without a file renders as a wordmark. The grid lists only
protocols, chains, and the event the repository actually touches: it is not a backers section,
because Helico has none. The canvas is a
React island that cycles through four scripted scenarios (commit a mandate, re-centre through
the enclave, refuse tampered thresholds, hold while in range) with the chat on the left and what
happened behind it on the right. Illustrative; the numbers are the ones the repository recorded.

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
| Sections | `src/components/sections/*.astro` (Nav, Hero, Brands, Enforcement, Build, Verified, Faq, Updates, Footer) |
| Head, icons, metadata | `src/layouts/Base.astro`, `public/site.webmanifest` |
| The canvas island | `src/components/canvas/HeroCanvas.tsx` (frame), `TuiCanvas.tsx` and `TgCanvas.tsx` (chat surfaces), `OutputCanvas.tsx` and `glyphs.tsx` (the voyage) |
| Scenarios | `src/components/canvas/cycles.ts` (chat), `provenance.ts` (stations) |
| Theme and page primitives (cards, buttons, chips) | `src/styles/global.css` (Tailwind v4 `@theme`) |

## Do not forget

- Biome skips `.astro` files and `public/`; the island's `.tsx` and the CSS are checked. The terminal's
  scrollback keeps `tabIndex={0}` (axe requires scrollable regions to be keyboard-reachable), so
  `noNoninteractiveTabindex` is off for that one file in `biome.json`.
- The nav logo goes through `astro:assets` (WebP at 1x and 2x); the manifest icons are WebP; the
  OG image is `public/og.webp`. The only PNG left is the 180 px Apple touch icon.
- The island loads with `client:visible`, so React and framer-motion (about 340 KB before
  compression) only load when the section approaches.

## Blog

`/blog` and `/blog/<slug>` are built at build time from one source of truth, the Markdown in
[`apps/be/content`](../be/content): through the backend's API when `BE_URL` is set and it
answers (`BE_URL=http://127.0.0.1:8787 bun run build`), otherwise straight from the files
through a content collection. The build log says which (`[blog] 4 posts from the api|files`).
The article page follows a Medium article's measurements: a 680px column, a 42px title, a 22px
grey subtitle, an author row with a 48px avatar, and body copy in Source Serif 4 at 20px on
32px lines.

