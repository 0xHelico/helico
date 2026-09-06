# @helico/landing

The landing page, Astro 7. Two sections: a hero over an aurora that zooms on scroll, and the
canvas, a React island that cycles through four scripted scenarios (commit a mandate, re-centre
through the enclave, refuse tampered thresholds, hold while in range) with the chat on the left
and what happened behind it on the right. Illustrative; the numbers are the ones the repository
recorded.

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
| Page, nav, hero, scroll transforms | `src/pages/index.astro` |
| Head, icons, metadata | `src/layouts/Base.astro`, `public/site.webmanifest` |
| The canvas island | `src/components/canvas/HeroCanvas.tsx` (frame), `TuiCanvas.tsx` and `TgCanvas.tsx` (chat surfaces), `OutputCanvas.tsx` and `glyphs.tsx` (the voyage) |
| Scenarios | `src/components/canvas/cycles.ts` (chat), `provenance.ts` (stations) |
| Theme | `src/styles/global.css` (Tailwind v4 `@theme`) |

## Do not forget

- Biome skips `.astro` files and `public/`; the island's `.tsx` and the CSS are checked.
- The nav logo goes through `astro:assets` (WebP at 1x and 2x); the manifest icons are WebP; the
  OG image is `public/og.webp`. The only PNG left is the 180 px Apple touch icon.
- The island loads with `client:visible`, so React and framer-motion (about 340 KB before
  compression) only load when the section approaches.
