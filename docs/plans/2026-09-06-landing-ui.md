# Landing page: hero, nav, and the enclave canvas

Issue: #66. App: `apps/landing` (Astro 7).

## Problem

The landing is the starter placeholder. The submission needs a page that says what Helico is
in one screen and shows the enclave deciding, with the project's icons and metadata.

## Approach

Two sections, after a reference layout the user supplied:

1. **Hero.** A fixed background that zooms as the page scrolls (CSS gradient aurora in the
   logo's palette, no video, no image), a floating nav pill (logo, four links, a gradient-border
   "Get started"), a headline with a muted first line, one paragraph, and a single "Getting
   started" button where the reference had four popup cards. The hero fades and lifts on scroll.
2. **The canvas.** Replaces the reference's showcase card with the framed canvas the user pointed
   at from another project: an outer "painting" (a gradient per scenario), an inner frame, a chat
   surface on the left (terminal or messenger, alternating per scenario) and a "behind the chat"
   voyage on the right whose stations light up in sync with the chat. Four Helico scenarios cycle:
   commit a mandate, re-centre through the enclave (signature path), refuse tampered thresholds,
   hold while in range. Copy uses numbers the repo already recorded (ETH/ARB pool at tick 130472,
   the 0x134be6bb… mandate hash, EIP-712 nonce 7) and the canvas is labelled illustrative.

Implementation: Astro for everything static; the canvas is one React island (`@astrojs/react`,
`framer-motion`) because the source is React and the animation choreography is worth keeping;
Tailwind v4 through `@tailwindcss/vite` for the island's utility classes. Icons: the user's logo
set copied into `public/` (favicons, apple-touch-icon, manifest with the names filled in); the nav
logo goes through `astro:assets` so it ships as a small WebP at 1x and 2x rather than the 47 KB
PNG. `prefers-reduced-motion` disables the background animation and the scroll transforms.

## How to verify

1. `bun run --filter @helico/landing typecheck` (`astro check`), `build`, and `bunx biome check`
   at the root: clean.
2. `astro build` output: no asset over 100 KB except fonts loaded from Google Fonts; the nav
   logo is a generated WebP.
3. In the browser: the background zooms, the hero fades, the canvas scales in and cycles through
   the four scenarios; with reduced motion, no animation but every element visible.

## Prompts

The user, in Indonesian, asked to remake a reference HTML (`7.html`, a "ContentFlow" template)
in Astro for the landing, use the `logo-helico` set for icons and metadata, replace the second
section with the `HeroCanvas` composition from another project of theirs "but with Helico
inside", replace the four popup cards with a single "Getting started" button, adjust everything
to Helico, optimise heavy assets, and keep the issue-and-PR workflow.
