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

## Revision — same day, a different reference

Mid-build the user switched the reference to a long single-page protocol site and asked for its
style with Helico's content: white page, big rounded section cards whose lavender fades to white
at the top, a dark rounded section, pill buttons, card grids, stats, an FAQ, and a footer with
columns. The canvas island stays and takes the place of the app mockup in the hero. The earlier
aurora background, the popup-card hero, and page-by-page scroll snapping were dropped with it.

Sections now: nav, hero (with the canvas), stay-updated strip, "under the hood" (dark: a
product-style panel of one mandate and its four gates, three mandate templates), "build with
Helico" (the two plugins and the vault, with test counts), "verified by default" (six facts that
are true of the repository today and a chart of liquidity retained by a re-centre), FAQ, a second
updates strip, footer with a plain-language disclaimer.

Verification added: a headless-browser audit script (Playwright, kept outside the repo) that
loads the production build at seven viewports, checks for horizontal overflow, the island's
hydration and scenario switching, console errors, and runs axe; it reports zero findings.

## Revision — content, after reading five protocol sites

The user asked for two more things once the layout matched the reference: the reference's
exact widths, and a content pass informed by five protocol landing pages (a lending
protocol, a credit network, a yield optimiser, an automated LP manager, and a liquid-staking
protocol), with a proposal for what Helico should learn from them. The collaborator reviewed
the page at the same time with one lens, claims that are not true, and requested changes.
Both sets of changes landed together.

**Widths.** Measured with a headless browser on the reference at 1440, 1920 and 2560: the big
section cards run edge to edge minus a 24px gutter, and everything inside them, nav and footer
included, sits in a centred 986px column. The page now does the same; the wrapper class was
renamed because Tailwind's `container` utility shares the name and its breakpoint caps were
winning. The canvas alone breaks out of the column (to 80rem), because at 986px it read as too
small.

**What the five sites share.** One plain-language promise and one benefit line in the hero, live
numbers, a strip of the protocols used, products as cards, a security section that names each
mechanism rather than saying "audited", a builders section, trust numbers, an FAQ, a closing
call to action, and a footer with disclaimers. The two automation products among them are the
closest to Helico: one names its guards as cards ("rebalances can only touch pre-approved
contracts; anything else reverts"), the other says when it does *not* act. The credit network
shows its contract source on the page as a trust device.

**What Helico takes from that, and what it refuses.** Taken: a "built with" strip; the seven
mandate fields as eight rule cards (seven fields plus the price-inside rule), each linking to
the line in the vault, pinned to a commit so the anchors stay true; a section on holds and
refusals ("most of the time, it does nothing"); the `_checkRange` function on the page, read from
the vault source at build time; a closing call to action; the live tick of the demo pool in the
hero, read with one `eth_call` to `StateView` on the public Arbitrum One RPC and labelled
"live". Refused: trust numbers Helico does not have (TVL, years, professional audits) and any
"trusted by default" framing built on them.

**The collaborator's corrections.** Robinhood Chain mainnet was read-only and the transactions
ran on Robinhood Chain Testnet, so the networks fact now says exactly that and counts four;
the two unsourced chart rows (81% and 98%) are gone and the chart keeps the two rows the swap
plan records; the dark panel no longer shows a vault address or an "active" badge, and carries
an illustrative caption; the unit-test count is "240+" with the per-package breakdown
(52 + 116 + 74) and the fork suite is nine tests; the "fee ≤ 0.3%" chip, which is an
enclave-side config rather than a mandate field, is replaced with a real field; the email input
that led nowhere is replaced with a "watch on GitHub" button. The FAQ grew from five questions
to seven (who holds the position, what it costs, "is it live? is it audited?").

### Prompts, verbatim in translation

- "Match the max width; you can test it directly on the reference site."
- "Study the content of these five sites and think about how Helico should be, from those
  concepts." (five URLs)
- "Go on." (to the proposal)
- "And the canvas is too small."

## Revision — the reference's type scale and its four cards

The user asked for the reference's wording style, type sizes, font, button dimensions,
description lengths and card styles, with Helico's content, and for its structure of three
lavender cards and one black card. Measured on the reference with a headless browser at 1440:

| Element | Reference | Here |
|---|---|---|
| Font | a proprietary grotesk, weight 550 for headings | Inter (variable, 100 to 900) at the same weights |
| Hero and section headings | 72px, weight 550, line-height 1.1, tracking −0.05em, 90% ink | same |
| Lede | 20px, 400, line-height 1.36, tracking −0.01em, 65% ink, max 620px | same |
| Sub-headings inside cards | 40px, 500, tracking −0.03em, left | same |
| Buttons | 48px tall, 24px side padding, 17px/500, radius 99px | same geometry; the lavender is two notches darker (`#695cff`) so white text passes 4.5:1, which the reference's does not |
| Section cards | radius 32px, 24px gutter and 24px gaps | same |
| Small cards | 313px wide, radius 24px, padding 32px, 1px 5% border | same |
| Stat cards | 24px/450 number, 16px caption at #636161 | same |
| Nav | 82px bar, 14px/450 links at 65% ink, ink pill CTA 32px tall | same |
| FAQ | 40px "FAQs" left, 662px column, 16px questions with a 1px rule | same |
| Descriptions | 8 to 14 words under a heading, one sentence per card | same |

Structure, top to bottom: hero (lavender), stay-updated (white card), the mandate (black),
build (lavender), verified (lavender), FAQ, stay-updated, footer. Everything the previous
revision added was folded into those four cards rather than dropped: the rule links live in
the mandate panel as one row per field, the `_checkRange` figure is the visual of the build
card, the live tick is the sixth stat card, and the holds-and-refusals section became the FAQ
entry "When does it do nothing?". The "built with" strip and the closing call to action were
dropped because the reference has neither.

### Prompts, verbatim in translation

- "Check the reference: wording, text style, font size, font family, button, description
  length, card and info styles, and the rest. Match it, only the content stays Helico. And I
  see three pink cards and one black card; follow that."

## Revision — a marquee in place of the first updates card

The user asked for the white card under the hero to become a logo marquee and for a list of
brands so they could find the logos. `Brands.astro` scrolls a list of eleven names, every one
something the repository builds on or ran against: Uniswap v4, Chainlink CRE, Arbitrum One,
Robinhood Chain, Base, OpenZeppelin, Foundry, viem, Bun, Astro, ETHGlobal. A logo dropped at
`src/assets/brands/<slug>.svg` replaces the wordmark through `import.meta.glob`; until then the
name renders as text. The loop is CSS only, pauses on hover, and collapses to a static wrapped
row under `prefers-reduced-motion`. The second updates card stays at the bottom.

### Prompt, verbatim in translation

- "Replace this one with a marquee. Write down which brands, I will find the logos."

## Revision — the marquee becomes a grid, and stays honest

The user then pointed at a "backed by" grid on a credit-network site: four columns, hairline
dividers, eleven logos and a twelfth cell that opens the rest. The grid replaced the marquee.
The user's note that the reference is a *backers* section, not a tools section, is the reason
the content did not follow it: Helico has no backers, and the hackathon's prize sponsors are not
that, so a "Backed by" heading over their logos would be the misrepresentation the rules
disqualify for. The section is titled "Built on" and lists only the protocols, chains, and the
event the repository touches: Uniswap v4, Chainlink CRE, Arbitrum One, Robinhood Chain, Base,
OpenZeppelin, Foundry, ETHGlobal. The dev tooling that briefly padded the list to twenty is
gone. With eight entries the "View More" cell does not render; the toggle stays in the
component for the day the list grows past eleven. Five logos supplied by the user were shrunk
to 160px WebP sources; `astro:assets` emits the served sizes.

### Prompts, verbatim in translation

- "Make it like this instead: eleven shown, the rest behind view more." (two screenshots of
  the reference grid)
- "That one is backed-by, not the features used."

## Revision — the reference's navigation, the code block as an editor

The user asked for the reference's navigation: a hovered item becomes a light pill and opens
a full-width white panel of cards under the bar (icon tile, title with an optional badge,
one-line subtitle, an arrow on links that leave the page), and on small screens a hamburger
that opens a full-screen sheet with the same cards stacked under group headings. Measured on
the reference: hovered pill `rgba(0,0,0,.03)` at radius 50 with the text at full ink; panel
grid of three 318px cards with 16px gaps in the 986px column; cards 74px tall, radius 24,
padding 16, a 1px 5% hairline; 40px icons; 10px/600 lavender badges; 14px/450 subtitles at
65% ink. The icons are Helico's own line glyphs drawn for the tiles, not the reference's
files. Four groups (Product, How It Works, Developers, Evidence) with Helico's destinations,
FAQ stays a plain link. Hover opens on pointer devices; focus, click, Escape and leaving the
bar work everywhere, and the sheet locks page scroll while open.

The user also asked for the code block to be coloured "like VS Code" with line numbers. It is
rendered at build time by Astro's `Code` component (Shiki, `dark-plus`, Solidity grammar) on
the editor's own background, and the gutter shows the file's real line numbers, computed from
the source at build time so they match the GitHub link.

### Prompts, verbatim in translation

- "The nav on the reference when I hover: the hovered item gets highlighted." (four
  screenshots of its open menus)
- "Like this in mobile mode." (two screenshots)
- "Check every responsive size, not only two views."
- "Give the code colouring so it looks good, with line numbers, like VS Code."

## Revision — footer, icons, tablet sheet, and the unfolding panel

Four more asks, all against the same reference. The footer now lives inside the last lavender
card together with the stay-updated card: four link columns with lavender titles, a brand row
with the wordmark in lavender and the GitHub mark, and a long muted legal line, the way the
reference closes. The user supplied twelve two-tone icons taken from the reference's own
navigation and asked that they be used for the nav, with any further ones drawn in the same
style; they are inlined in `Nav.astro` and recoloured with Helico's own greys, turning lavender
on hover. On tablets the sheet lays its cards in two columns. And the panel no longer appears:
its single grid row unfolds from `0fr` to `1fr` and the cards fade in just behind it, with the
transition removed under `prefers-reduced-motion`.

On writing, the user pointed out that every heading on the reference is a general claim about
the product rather than an explanation ("The World's Savings App", "Trusted by Default", "The
home of stablecoins."). Helico's headings already followed that pattern except one, which was
explanatory ("Why the swap is inside the vault.") and is now a claim ("Moves that keep the
position.") with the explanation in the line under it.

### Prompts, verbatim in translation

- "Tidy the footer too, it is very different; match the style."
- "Look at the writing on the reference: every section heading is a general claim about what
  it is and its advantage, not an explanation. Right?"
- "Here, for the tablet nav." (a screenshot of the two-column sheet)
- (twelve SVG icons) "Use these for the nav; for the others you can draw your own in a similar
  style."
- "And when hovering a menu there is an animation, the menu comes down, not appearing at once."

## Revision — the bar itself

The user found the bar too tall and wanted the logo alone on the left with everything else on
the right. Measured on the reference at 1000, 1280 and 1440: a fixed, transparent 82px bar over
the hero card (which starts at the top of the page, under it), becoming a 64px white bar with a
hairline once the page scrolls; the wordmark 16px tall; the links 8px apart and the button 16px
after them, the group flush with the right edge of the column. The page now does the same, and
the numbers read back equal: bar 82 then 64, links 8px apart, button 16px after, its right edge
on the column's edge, the hero card at y = 0.

### Prompt, verbatim in translation

- "The nav is too tall, and it should be the logo on the left and the rest on the right."

