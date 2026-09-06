# AI usage

ETHOnline 2026 requires submissions to explain **how AI was used, where, and with what
instructions**. This file is that record, kept as work happens rather than reconstructed
near the deadline.

The rule is not a prohibition on using AI — ETHGlobal actively encourages it. What is
forbidden is **not understanding the result**, and **claiming an integration that is not
proven to work**.

## Tools

| Tool | Model | Used for |
|---|---|---|
| Claude Code | Opus 5 | Hackathon rule research, repository scaffolding, workshop session notes |
| Claude Code | Fable 5.1 | Uniswap plugin (`packages/plugins/uniswap`), its plan, README, and `FEEDBACK.md` |
| Claude Code | Fable 5.1 | Chainlink CRE plugin scaffold (`packages/plugins/cre`), its plan and README |
| Claude Code | Fable 5.1 | Monorepo tooling — bun workspaces (started on pnpm), Turborepo, Biome, Husky, `packages/` scaffold |
| Claude Code | Fable 5.1 | Landing page starter (`apps/landing`), its plan and README |

## Log

Format: date · what was done · the AI's role · what a human verified.

### 2026-09-05 — Repository scaffold

- **Done:** monorepo layout, compliance `CLAUDE.md`, supporting files.
- **AI's role:** compiled the rules from official ETHGlobal workshop transcripts and the
  event prize page, then wrote them up as working rules. Drafted the scaffold files.
- **Verified:** every rule traced back to its source — a spoken transcript or the official
  prize page. Conflicts between sources were recorded rather than silently resolved.
- **No application code yet.**

### 2026-09-05 — Monorepo tooling

- **Done:** pnpm workspaces and Turborepo at the root, a base `tsconfig`, `packages/core`
  (`@helico/core`), and the `packages/plugins/<name>` layout. Layout tables updated.
- **AI's role:** wrote every file in the change from the instruction below. The human chose
  pnpm, the `packages/` split, and the issue-then-PR workflow.
- **Prompt:** *"Set up this monorepo with turbo and make a `packages` folder to hold core and
  the plugins"*, then *"use pnpm workspaces"* (given in Indonesian, translated here).
- **Plan:** not needed — tooling only, no application code.
- **Verified:** `pnpm install` then `pnpm typecheck` from the root. Turborepo ran
  `tsc --noEmit` in `@helico/core` and it passed. Nothing else exists to test yet.

### 2026-09-05 — Switch the workspace from pnpm to bun

- **Done:** root `package.json` now declares bun workspaces and `packageManager: bun@1.3.14`;
  `pnpm-workspace.yaml` and `pnpm-lock.yaml` removed, `bun.lock` committed. Turborepo
  scripts unchanged.
- **AI's role:** proposed keeping pnpm, then recommended the switch once the Chainlink CRE
  work showed bun is mandatory anyway; verified Turborepo on bun workspaces in a scratch
  project first, then applied it. The human decided.
- **Prompt:** *"How about using bun for everything?"* then *"Yes, switch, while the pnpm
  PRs are not merged yet."* (Indonesian, translated.)
- **Plan:** not needed — tooling only.
- **Verified:** `bun install`, then `bun run typecheck` from the root: Turborepo ran
  `tsc --noEmit` in `@helico/core`, 1 task successful.

### 2026-09-05 — Biome and Husky

- **Done:** `biome.json` at the root with an explicit rule set, `.vscode` settings so the
  editor formats with Biome, Husky `pre-commit` (Biome on staged files) and `commit-msg`
  (Conventional Commits) hooks, root scripts `check`, `fix`, `format`, `lint`. Existing
  files formatted once in their own commit.
- **AI's role:** dry-ran candidate configs against the CRE template files first, read
  Chainlink's own Biome config to match its style, wrote the config and hooks, ran the checks.
- **Prompt:** *"Also set up a formatter with Biome, and make sure the config is thorough"*,
  then *"also add Husky"* (Indonesian, translated).
- **Plan:** not needed — tooling only.
- **Verified:** `bun run check` exits 0 on the whole repo; a commit with the message
  `bad message` is rejected by the hook; the real commits pass the staged check.

### 2026-09-05 — Landing page starter

- **Done:** `apps/landing` (`@helico/landing`): Astro 7 from the official `minimal` template
  via `create-astro`, `tsconfig` on `astro/tsconfigs/strict`, a typed base layout, one
  placeholder page, `astro check` as the workspace `typecheck`. Root Biome config now skips
  `.astro` files and `public/` assets.
- **AI's role:** read Astro's build-with-AI, TypeScript, Bun, and v7 upgrade guides and
  Biome's language-support page first; trial-scaffolded and built in a scratch directory;
  wrote the plan, layout, page, README; ran the checks. The human chose Astro and the scope.
- **Plan:** [`docs/plans/2026-09-05-landing-starter.md`](docs/plans/2026-09-05-landing-starter.md),
  prompt included.
- **Verified:** `bun install`, `bun run --filter @helico/landing typecheck` (`astro check`:
  0 errors, 0 warnings), `build` (1 page, `dist/index.html`), `bun run typecheck --force`
  (Turborepo, all packages), `bun run check` (Biome clean). Not deployed anywhere yet.

### 2026-09-05 — Chainlink CRE plugin scaffold

- **Done:** `packages/plugins/cre` (`@helico/plugin-cre`), a reusable package holding the
  confidential handler from Chainlink's `hello-confidential-workflows-ts` template,
  scaffolded with `cre init`. `src/index.ts` is the template's `workflow.ts`, unchanged apart from
  Biome formatting; the package layout, tsconfig, tests location, and README are ours. `apps/cre` untouched.
- **AI's role:** researched the CRE docs, the template repository, and Chainlink's agent
  skill first; wrote the plan and its revision, the package layout, and the README; ran the
  checks. The handler logic is Chainlink's, and the README says so.
- **Plan:** [`docs/plans/2026-09-05-plugin-cre.md`](docs/plans/2026-09-05-plugin-cre.md),
  prompts included.
- **Verified:** `bun install`, `bun run --filter @helico/plugin-cre typecheck` (clean), `test`
  (9 pass, 0 fail), re-run after the switch to bun. WASM compile and `cre workflow simulate` (CLI v1.32.0) verified from a
  throwaway CRE project outside the repo that imports the package: TEE banner shown, result
  `REJECT (score: N, secret reached API: true)`. **Not deployed**: no deploy access on the
  machine's CRE account, and Confidential Workflows is a separate private beta.

### 2026-09-05 — CRE plugin review fixes

- **Done:** README anchors point at the whole `initWorkflow` (`L118-L136`); the TEE test
  asserts the actual constraint (Nitro, `us-west-2`) instead of presence; the package README
  states that the test file is the template's too; the plan carries a status note; `apps/cre`
  points at the package and at #20/#21.
- **AI's role:** applied the collaborator's review findings; ran the checks.
- **Verified:** `bun run --filter @helico/plugin-cre typecheck` and `test` (9 pass), `bun run check`.

### 2026-09-05 — Uniswap plugin

- **Done:** `packages/plugins/uniswap` (`@helico/plugin-uniswap`): v4 addresses from the
  SDKs, pool id, `StateView` reads, v4 `Quoter` quotes, Universal Router swap calldata via
  `V4Planner`. Offline tests, a live smoke script, README, `FEEDBACK.md` filled in.
- **AI's role:** read the Uniswap AI skills, the v4-periphery and v4-core interfaces, and
  the deployments page first; probed the SDKs under bun and the live pool on Base before
  writing; wrote the plan, code, tests, and docs; ran every check. The human chose the
  package, its scope, and the on-chain path over the Trading API.
- **Plan:** [`docs/plans/2026-09-05-plugin-uniswap.md`](docs/plans/2026-09-05-plugin-uniswap.md),
  prompts included.
- **Verified:** `bun run --filter @helico/plugin-uniswap typecheck` (clean), `test` (8 pass,
  0 fail, offline), `smoke` against Base through viem's public RPC: live pool state, a live
  quote (1 ETH → 2,448.94 USDC at the time), and the SDK-built swap calldata accepted by the
  Universal Router in an `eth_call` from an ETH-holding address. **No transaction was sent.**
  `bun run check` clean.

### 2026-09-05 — Uniswap plugin, complete and modular

- **Done:** `@helico/plugin-uniswap` split into `addresses`, `pool`, `quote`, `swap`,
  `approval`, `liquidity` (plus `abi/`, `types`, `client`), one test file per module, a barrel
  `index.ts`, and a smoke script covering pools, all four swap shapes, and allowances.
- **AI's role:** read the v4-sdk, universal-router-sdk, permit2-sdk, v4-periphery, and
  v4-core sources for the exact structs and constructor orders; wrote the plan, modules,
  tests, docs; ran every check and fixed what the live simulation caught (a v4 `SWEEP` the
  router rejects, a degenerate round-trip route). The human asked for the scope and the
  modular shape.
- **Plan:** [`docs/plans/2026-09-05-plugin-uniswap-complete.md`](docs/plans/2026-09-05-plugin-uniswap-complete.md),
  prompt included.
- **Verified:** `typecheck` clean; `test` 39 pass, 0 fail across 6 files, offline; `smoke`
  live on Base: pool state and price, exact-in and exact-out quotes, single-hop and
  multi-hop (ETH → USDC → USDT) swap calldata for all four shapes accepted by the Universal
  Router via `eth_call`, allowance read. **Nothing sent. Liquidity calldata decoded, not
  simulated.** `bun run check` clean.

### 2026-09-05 — Uniswap plugin executed on Base Sepolia

- **Done:** `packages/plugins/uniswap/src/e2e.ts` and the `e2e` script: the package's own
  builders run for real with a test wallet, one transaction hash per step, recorded in the
  package README.
- **AI's role:** wrote the script, diagnosed the two failures on the way (a lagging public
  RPC, an under-estimated gas limit) from receipts and re-simulation, fixed the script, and
  cleaned up the positions left by the partial runs. The human supplied the wallet.
- **Plan:** revision in
  [`docs/plans/2026-09-05-plugin-uniswap-complete.md`](docs/plans/2026-09-05-plugin-uniswap-complete.md).
- **Verified:** on Base Sepolia, wallet `0x7461…88C0`: mint (NFT #27362), exact-in swap,
  exact-out swap with the router-level refund (received exactly 0.5 USDC), ERC-20-input swap
  through the Permit2 allowance, collect, decrease 100 % and burn, all `status: success`.
  `initializePool` and `increaseLiquidity` remain decoded in tests only. The key was never
  written to the repository.

### 2026-09-05 — Uniswap plugin accepts any viem client

- **Done:** reads take a generic viem `Client` and use `viem/actions`; scripts and tests are
  type-checked (`@types/bun`, `types: ["bun"]`); a `request`-level fake client for tests;
  `.env.example`; numeric separators and `.at(-1)` per the editor's linter.
- **AI's role:** diagnosed the editor diagnostics the human pasted, applied viem's own
  guidance for libraries, rewrote the fakes, ran the checks.
- **Plan:** revision in
  [`docs/plans/2026-09-05-plugin-uniswap-complete.md`](docs/plans/2026-09-05-plugin-uniswap-complete.md).
- **Verified:** `typecheck` clean over `src/**` including `e2e.ts`; `test` 40 pass; `smoke`
  live on Base; `bun run check` clean.

### 2026-09-05 — Uniswap plugin: any chain, Robinhood Chain, review fixes

- **Done:** `addresses()` resolves any chain (SDK, documented deployments, or
  `registerV4Addresses()`) and picks the Universal Router version per chain; encoders build
  the 2.1.1 structs where needed; `networks.ts` registry with Robinhood Chain mainnet and
  testnet definitions; scripts take `CHAIN`; the e2e is self-contained (native/wrapped pool);
  review fixes from #8.
- **AI's role:** researched Robinhood Chain (docs, explorers, on-chain bytecode comparison,
  `Initialize` logs), the SDK's router version tables, and the v4-periphery router source;
  wrote the code, tests, and docs; ran the checks. The human chose the chains and the
  any-chain requirement.
- **Plan:** revision in
  [`docs/plans/2026-09-05-plugin-uniswap-complete.md`](docs/plans/2026-09-05-plugin-uniswap-complete.md).
- **Verified:** `typecheck` (all packages), `test` (48 pass), `bun run check`; e2e on Base
  Sepolia with the new self-contained flow: 12 transactions, all `status: success`, including
  `initializePool` and `increaseLiquidity`. Robinhood Chain mainnet smoke passed (router 2.1.1, ETH/USDG 87/1,
  quotes and both swap shapes accepted via `eth_call`); the testnet e2e ran with faucet ETH: 12 transactions, all
  `status: success`, through router 2.1.1 (hashes in the package README).

### 2026-09-05 — CRE plugin: the mandate decision inside the enclave

- **Done:** replaced the template's placeholder with Helico's logic in
  `packages/plugins/cre`: `mandate.ts` (struct, `keccak256(abi.encode(...))` hash, secrets
  parsing), `decision.ts` (pure re-centre rule), and the enclave callback in `src/index.ts`
  (hash check, `eth_call` to `StateView.getSlot0` through the HTTP capability, verdict-only
  report). SDK bumped to 1.19.1.
- **AI's role:** read the SDK 1.19.1 declarations (`TeeRuntime`, `getSecrets`, HTTP request
  shape), wrote the code, tests, and docs, ran the simulator and debugged two WASM-runtime
  differences (no `URL`, negative `int24` needs a `bigint`). The humans decided the product
  shape in #30/#31 and the split between public config and secrets.
- **Plan:** [`docs/plans/2026-09-05-cre-mandate-decision.md`](docs/plans/2026-09-05-cre-mandate-decision.md).
- **Verified:** `typecheck`, `test` (26 pass; the hash vector is cross-checked against
  `cast abi-encode` + `cast keccak`), `bun run check`; three `cre workflow simulate` runs
  from a throwaway project against the Robinhood Chain Testnet ETH/WETH pool: `RECENTER
  -560..440`, `HOLD (in range)`, `HOLD (mandate hash mismatch)` (table in the package README).

### 2026-09-05 — CRE plugin: aligned with the vault's mandate rules

- **Done:** `packages/plugins/cre` follows the vault on `feat/vault-contract` (#34): fields and
  secret ids renamed to `rangeWidthTicks` / `maxLiquidity` (same layout, same hash);
  `decision.ts` now mirrors `HelicoVault._checkRange` (`vaultRejects`) and only emits a range
  the vault would accept; the README says what the enclave keeps confidential now that the
  mandate is public on-chain.
- **AI's role:** reviewed the vault contract from a clean worktree (`forge test`, 44 pass),
  found the semantic mismatch on `minImprovementBps` and the public-mandate point, wrote the
  mirror, the grid test, and the docs. The collaborator asked for the renames in #34; the
  human chose to keep the contract as the source of truth.
- **Plan:** [`docs/plans/2026-09-05-cre-vault-alignment.md`](docs/plans/2026-09-05-cre-vault-alignment.md).
- **Verified:** `typecheck`, `test` (32 pass, including a grid over ticks, spacings, widths, and
  thresholds asserting every `act = true` verdict passes the vault's rule), `bun run check`;
  three `cre workflow simulate` runs with the renamed secrets against the Robinhood Chain
  Testnet ETH/WETH pool: `RECENTER -560..440`, `HOLD (in range)`, `HOLD (mandate hash mismatch)`.

### 2026-09-05 — CRE plugin: read the vault, size the mint, deliver the report

- **Done:** `packages/plugins/cre` reads the account, pool, and position from the chain inside
  the enclave (`chain.ts`), ports the Uniswap sqrt-price arithmetic to native `BigInt`
  (`math.ts`, cross-checked against `@uniswap/v3-sdk`), sizes the mint the burn will fund
  (`sizing.ts`), and delivers `abi.encode(act, mandateHash, RecenterParams)` to the vault with
  `EVMClient.writeReport` (`deliver`). Config drops the position and the tick spacing; the
  retained-liquidity floor is the mandate's `minRetainedBps` from #39.
- **AI's role:** read the CRE docs on on-chain writes and the forwarder directory, the SDK's
  generated EVM client, and the vault on `main`; wrote the code, the fake runtime, and the
  tests; found that an out-of-range position holds one token and so cannot fund a two-sided
  range without a swap, and reported it with live-pool numbers on #37. The humans decided the
  chains (both Robinhood networks) and own the contract side.
- **Plan:** [`docs/plans/2026-09-05-cre-forwarder-delivery.md`](docs/plans/2026-09-05-cre-forwarder-delivery.md).
- **Revised after review (same day):** the review of #40 found that `minRetainedBps = 0` let a
  zero mint through (`0 < 0`); fixed with an unconditional hold on a zero mint. #42 chose the
  swap: `sizeRecentre` now sizes `zeroForOne`, `amountIn`, `minAmountOut` (swap estimated at
  the pool's active liquidity with the pool's fee, bounded to the new range) and the report
  tuple carries them; `maxPoolFeePips` is enclave policy. The report tuple is pinned to a
  `cast abi-encode` vector, the RPC fault paths and the boundary cases are tested.
- **Verified:** `typecheck`, `test` (100 pass), `bun run check`. Not run against a deployed
  vault and not simulated with this binary: the vault with the swap leg is pending (#42).

### 2026-09-05 — CRE plugin: sizing script for the fork cross-check

- **Done:** `packages/plugins/cre/src/size.ts`, a package script that prints `sizeRecentre`'s
  output for an explicit chain state (JSON, or the ABI-encoded `RecenterParams` for `vm.ffi`),
  behind a pure `sizeForState`; the package now type-checks its tests too (`types: ["bun"]`).
- **AI's role:** wrote the script, the tests, and the worked example from the live demo pool;
  the collaborator asked for the cross-check on #43.
- **Plan:** small tooling, tracked in #45; no separate plan document.
- **Verified:** `typecheck` (tests included now, three type mismatches in existing tests fixed),
  `test` (105 pass), `bun run check`; the example in the package README was produced by the
  script from the pool state read with `cast` at block 55182962.
### 2026-09-05 — CRE plugin: the enclave signs the re-centre

- **Done:** `packages/plugins/cre/src/sign.ts` (EIP-712 `Recenter(RecenterParams params, bytes32
  mandateHash, uint256 nonce)` with the vault's struct nested, `signRecentre`,
  `recoverRecentreSigner`, `encodeAuthorisation`), `relay.ts` (calldata for the vault's
  signature entry point), and `delivery: 'signature'` in the handler: the agent key comes from
  the Vault DON as a secret, the nonce from the vault, and only the signed authorisation crosses
  out. `delivery: 'forwarder'` keeps `writeReport`.
- **AI's role:** proved signing inside the TEE handler in the simulator (#41), wrote the module,
  the by-hand EIP-712 digest check, the handler tests including "the key never leaves", and the
  docs. The collaborator accepted the typed struct; the contract side is his.
- **Plan:** [`docs/plans/2026-09-05-cre-enclave-signature.md`](docs/plans/2026-09-05-cre-enclave-signature.md).
- **Verified:** `typecheck`, `test` (110 pass), `bun run check`. Not simulated with this
  binary and not run against a deployed vault: the vault's `nonces` and
  `recenterWithSignature` do not exist yet, so the simulation is recorded as pending.

### 2026-09-06 — CRE plugin: docs for the move to Arbitrum One

- **Done:** package README and the two delivery plans point at Arbitrum One (#58): the CRE
  selector, both forwarders and what each verifies, the v4 addresses from the SDK, the demo
  pool, and the dependency on the vault's `onReport`. No code change; the chain was config.
- **AI's role:** verified the addresses on chain (`typeAndVersion()` on both forwarders, the pool's
  id and liquidity) and wrote the docs. The collaborator made the chain decision on #58.
- **Plan:** revisions in the two plans; tracked in #61.
- **Verified:** `bun run check`, `python3 scripts/check-readme-links.py` (root README untouched).

### 2026-09-06 — Uniswap plugin: reference pool and smoke on Arbitrum One

- **Done:** `networks.ts` gains the hook-less ETH/USDC 0.05 % pool as Arbitrum One's reference
  pool, after reading its liquidity from `StateView`; the keyless smoke runs there and the README
  records it.
- **AI's role:** read the pool live, made the one-line change, ran the smoke, wrote the docs. The
  chain move is the collaborator's decision (#58).
- **Plan:** one-line change tracked in #63; no separate plan document.
- **Verified:** `typecheck`, `test` (52 pass), `bun run check`; `CHAIN=arbitrum bun run smoke`
  output quoted in the package README.

### 2026-09-06 — Landing page

- **Done:** `apps/landing` replaced the starter with a long single page in the style of a
  modern protocol site: nav, hero with the canvas island (four Helico scenarios, terminal and
  messenger surfaces, the "behind the chat" voyage), stay-updated strip, a dark under-the-hood
  section, build, verified-by-default facts and a chart, FAQ, footer. Icons and metadata from
  the Helico logo set; React and Tailwind v4 added to the Astro app for the island.
- **AI's role:** rebuilt a reference HTML layout the user supplied in Astro and ported a React
  canvas composition from another project of theirs, rewriting every string and colour for
  Helico; wrote the scenarios from numbers already recorded in this repository; optimised the
  assets (WebP nav logo through `astro:assets`, WebP manifest and OG icons, lazy island).
- **Plan:** [`docs/plans/2026-09-06-landing-ui.md`](docs/plans/2026-09-06-landing-ui.md), tracked in #66.
- **Verified:** `astro check` (0 errors), `astro build`, `bun run check` with Tailwind
  directives enabled in Biome; a Playwright audit of the production build at seven viewports
  (overflow, hydration, scenario switching, console, axe) with zero findings; output JS is
  React plus framer-motion behind `client:visible`, images under 45 KB each. Not yet deployed.

### 2026-09-06 — Landing page: widths and content

- **Done:** section cards run edge to edge with a 24px gutter and content sits in a 986px column,
  measured on the reference with a headless browser; the canvas breaks out to 80rem. Content
  rewritten after a reading of five protocol landing pages and the collaborator's review of
  the page's claims: a "built with" strip, the seven mandate fields as rule cards linking to
  pinned lines in the vault, a holds-and-refusals section, `_checkRange` rendered from the
  vault source at build time, honest test and network counts, a two-row chart with its source,
  a seven-question FAQ, a closing call to action, and a live tick read from Arbitrum One.
- **AI's role:** measured the reference, scraped the five sites' text and screenshots, wrote the
  proposal and, once approved, the copy and components; folded in every point of the
  collaborator's review. The user chose the sites and approved the proposal; the collaborator's
  review set the facts straight.
- **Plan:** revision in [`docs/plans/2026-09-06-landing-ui.md`](docs/plans/2026-09-06-landing-ui.md).
- **Verified:** `astro check` (0 errors), `astro build`, `bun run check`; widths re-measured at
  1440, 1920 and 2560 (986px column, 24px gutter, matching the reference to the pixel); the
  Playwright audit at seven viewports re-run on the build; the built HTML grepped for every
  claim the review flagged. Still not deployed.

### 2026-09-06 — Landing page: the reference's type scale and four-card structure

- **Done:** the page restructured to the reference's three lavender cards and one black card
  and restyled to its measured type scale (72px/550 headings, 20px ledes at 620px, 48px pill
  buttons, 32px section radius, 313px cards, 82px nav), with Inter as the stand-in for its
  proprietary face. The rules moved into the mandate panel as rows, the range check became the
  build card's visual, the live tick became a stat card, and holds and refusals became an FAQ
  entry.
- **AI's role:** measured the reference's computed styles with a headless browser, mapped the
  content onto its structure, wrote the CSS and components. The user chose the structure; the
  only deliberate deviation is a darker button lavender for contrast, recorded in the plan.
- **Plan:** revision in [`docs/plans/2026-09-06-landing-ui.md`](docs/plans/2026-09-06-landing-ui.md).
- **Verified:** `astro check` (0 errors), `astro build`, `bun run check`; computed styles on the
  build compared with the reference's at 1440 (heading 72px/550/−3.6px at 986px, lede
  20px at 620px, button 48px, card 313px, all equal); the Playwright audit at seven viewports
  with zero findings. Still not deployed.

### 2026-09-06 — Landing page: "built on" logo grid

- **Done:** the first stay-updated card became a logo grid (four columns, hairlines, a
  view-more cell when there are more than eleven) of the protocols, chains, and the event the
  repository touches. Logos are picked up from `src/assets/brands/` when present and rendered
  through `astro:assets`; wordmarks render until then. Five logos supplied by the user.
- **AI's role:** wrote the component, picked the list from the dependency manifests and the
  plugin's network table, and declined to title it "Backed by": Helico has no backers, and the
  hackathon's prize sponsors are not that. The user supplied the logos and the reference.
- **Verified:** `astro check` (0 errors), `astro build` with and without a throwaway SVG to prove
  the glob pickup, the view-more toggle exercised in a headless browser (12 cells to 20 while
  the list was longer), the Playwright audit at seven viewports.

### 2026-09-06 — Landing page: navigation menus and the highlighted code block

- **Done:** hover menus under the nav bar (four groups of cards with Helico's destinations,
  measured against the reference), a hamburger and full-screen sheet on small screens, and the
  range check rendered by Shiki in VS Code's Dark+ with the file's real line numbers.
- **AI's role:** measured the reference's open menu with a headless browser, wrote the
  components, the glyphs, and the behaviour (hover, focus, click, Escape, scroll lock), and
  exercised each in a headless browser at seven viewports. The user chose the reference and
  asked for the editor look.
- **Verified:** `astro check` (0 errors), `astro build`, the Playwright audit at seven
  viewports, and a behaviour script: hover opens and moving onto a card keeps it open, leaving
  closes, Tab opens, Escape closes and returns focus; the sheet opens, locks scroll, and closes
  on Escape at 360, 390 and 768.

### 2026-09-06 — Landing page: footer, nav icons, tablet sheet, unfolding panel

- **Done:** the footer folded into the last lavender card with the stay-updated card; twelve
  two-tone nav icons supplied by the user, recoloured and turning lavender on hover; a
  two-column sheet on tablets; the nav panel unfolding with a height transition and a card fade,
  off under reduced motion; one explanatory heading rewritten as a claim.
- **AI's role:** wrote the CSS and markup, inlined the icons the user supplied, and verified the
  transition and the closed state in a headless browser. The user supplied the icons and the
  reference screenshots.
- **Verified:** `astro check` (0 errors), `astro build`, the Playwright audit at seven viewports,
  a transition probe (row height 0 → 139px at 90 ms → 206px open → closed again on leave).

### 2026-09-06 — Landing page: the bar

- **Done:** the nav is a fixed, transparent 82px bar over the hero that becomes a 64px white bar
  with a hairline on scroll; logo left, links and button grouped on the right, spaced as the
  reference's.
- **AI's role:** measured the reference at three widths, wrote the CSS and the scroll toggle,
  read the numbers back from the build. The user asked for the change.
- **Verified:** `astro check` (0 errors), `astro build`, the Playwright audit at seven viewports,
  and a probe of the bar at the top and after scrolling.

### 2026-09-06 — Landing page: the new logo set

- **Done:** favicons, the touch icon, the manifest icons, the social image, and the in-page mark
  replaced with the logo set the user supplied; the manifest icons and the social image are
  WebP, the in-page source a 256px WebP the image pipeline resizes from. The mark is a rounded
  square, so the circular crops on the in-page logo were removed.
- **AI's role:** converted and wired the files; the user supplied the set.
- **Verified:** `astro build`, the icons served from the preview, the Playwright audit at seven
  viewports.

### 2026-09-06 — Vault: consume the enclave's verdict through the CRE forwarder

- **Done:** `HelicoVault` implements `IReceiver.onReport`, decodes
  `abi.encode(bool act, bytes32 mandateHash, RecenterParams p)`, and runs the existing
  `_recenter` — so a Chainlink CRE workflow can move a position, not just decide that it should.
  `forwarder` is an admin-set address, not a role; the deploy script takes an optional
  `FORWARDER_ADDRESS`.
- **AI's role:** read the `KeystoneForwarder` behaviour out of the notes taken from Chainlink's
  own source, wrote the contract, the 11 tests, and the docs; generated the cross-side encoding
  vector by running `encodeReport` from the CRE plugin rather than by hand. The collaborator
  decided the setter-not-constructor shape on #37; deployment is theirs.
- **Plan:** docs/plans/2026-09-06-vault-on-report.md
- **Verified:** `forge fmt --check`, `forge build`, `forge test` (94 pass with an Arbitrum RPC,
  85 pass and 9 skip without), `scripts/check-no-payable.py`, `scripts/check-storage-layout.py`
  (append-only, snapshot committed). Mutation-checked: removing the `act` guard and the mandate
  hash check fails exactly the two tests written for them.

### 2026-09-06 — CRE plugin: the forwarder path rehearsed on a fork of Arbitrum One

- **Done:** the workflow, in `delivery: forwarder`, read a vault deployed on a local fork of
  Arbitrum One (the vault from #70, forwarder set to the CRE CLI's mock), decided a re-centre,
  and wrote the report; the mock forwarder called `onReport`, the vault burned, swapped, and
  minted on the real ETH/ARB pool, and the owner ended with a new in-range position holding
  94.3% of the liquidity. A second run held on the cooldown. Recorded in the forwarder-delivery
  plan with the recipe and the scratch script; the plugin README's status reflects it.
- **AI's role:** set up the fork, ran the deploy script, wrote the scratch mint-and-mandate script
  (a copy of the fork test's helper), configured the consumer, ran the simulations, and verified
  every number on the fork with `cast`. No package code changed. The collaborator's #70 is the
  contract side.
- **Plan:** [`docs/plans/2026-09-05-cre-forwarder-delivery.md`](docs/plans/2026-09-05-cre-forwarder-delivery.md), rehearsal section; tracked in #71.
- **Verified:** transaction receipt (status 1, `Recentred` emitted), `positionOf`, `ownerOf`,
  `getPositionLiquidity`, `getPoolAndPositionInfo`, `lastActionAt`, and the vault's balances read
  back from the fork; `mandateHash()` in the package equal to the vault's hash. Not a live
  network, not a TEE, and the mock forwarder verifies no signatures.

### 2026-09-06 — Blog and the Go backend

- **Done:** `apps/be`, a Go service with SQLite (pure-Go driver, WAL), embedded migrations,
  Markdown rendered once on write, keyset pagination, `ETag`/`304`, gzip, problem+json,
  structured logs, graceful shutdown, a bearer token for writes, seeded from
  `apps/be/content/*.md`; tests at every layer. `/blog` and `/blog/<slug>` in the landing,
  measured on a Medium article, built from the API when `BE_URL` is set and from the same files
  otherwise. Four posts written from what the repository records. A Go step in CI.
- **AI's role:** designed and wrote the service, its tests, the pages, the loader, and the
  posts; measured the reference; ran every route with `curl`, both build paths, and the audit.
  The user asked for the blog, the reference, the language and the database, and lifted the
  earlier rule that kept `apps/be` off limits.
- **Plan:** [`docs/plans/2026-09-06-blog-and-backend.md`](docs/plans/2026-09-06-blog-and-backend.md), committed first; tracked in #73.
- **Verified:** `go vet`, `gofmt -l` empty, `go test -race ./...` (five packages); the server
  booted and every route exercised with `curl` (a `304`, a `201`, a `204`, gzip 6770 → 1946
  bytes, a restart that seeds nothing); `astro check`, `astro build` from the files and from
  the API (4 posts each way); the Playwright audit on `/blog` and two articles at seven
  viewports, zero findings; the landing audit unchanged at zero.

### 2026-09-06 — Landing page: the panel's tabs

- **Done:** the dark card's sidebar became real tabs (roles, arrow keys) with a panel each:
  mandate, position, enclave, vault, evidence, every line from the knowledge the repository
  records, caveats included.
- **AI's role:** wrote the markup, the script and the copy; exercised click and keyboard in a
  headless browser. The user asked for it.
- **Verified:** `astro check` (0 errors), `astro build`, the Playwright audit at seven viewports.
- **Review follow-up:** the Position tab's 98% (removed in #67 as unsourced) became the
  rehearsal's 94.3%, and the Solidity test counts are read from `contracts/test/` at build time
  instead of typed, checked against `forge test --list` (95, 10 fork).
- **Copy overhaul:** after the user pointed at aave.com and morpho.org, the tabs, rule labels,
  values, template chips, nav titles and one new FAQ were rewritten in the words a savings app
  would use, with the field names kept beside the plain labels for builders. Facts unchanged.
- **Second pass, from screenshots:** one line per rule, plainer templates, the counts and
  chart replaced by three promises and the rehearsal's 94%, the builders' section labelled as
  such, the FAQ unfolding, and an SEO pass (pipe-separated titles, canonical, robots, sitemap,
  JSON-LD). Verified with `astro check`, the build, and the audits at zero.

### 2026-09-06 — Landing page: plain words

- **Done:** the landing's copy rewritten for a reader who may not know crypto: the idea before
  the mechanism, terms explained or avoided, numbers explained, the panel tabs in the same
  register, the code figure marked for builders. Facts and caveats unchanged.
- **AI's role:** rewrote the copy against the knowledge the repository records. The user asked
  for the register.
- **Verified:** `astro check` (0 errors), `astro build`, the Playwright audit at seven viewports.

### 2026-09-06 — Vault: mint what it can afford, not what the agent guessed

- **Done:** `_mint` now sizes the mint from the price the swap actually reached and the tokens
  the vault actually holds, capped by the agent's `liquidityToMint`. Fixes #78, where a
  re-centre burned the position, did the swap, and then reverted because the enclave's swap
  model disagreed with the pool by 16%. `LiquidityAmounts` vendored like `TickMath`, with
  saturation rather than truncation on overflow.
- **AI's role:** found it by building the rehearsal in #79 and checking chain state rather than
  the transaction hash; diagnosed it wrongly first, said so on the issue, then measured the
  pool's active liquidity against the swap size to find the real cause. Wrote the library, the
  fix, and the fork test.
- **Plan:** docs/plans/2026-09-06-mint-what-the-vault-can-afford.md
- **Verified:** `forge test` 95 pass with an Arbitrum RPC; mutation — replacing `toMint` with
  the agent's number fails exactly the new test; storage layout unchanged; end to end on a fork
  through `rehearse.sh`, 93.19e18 in and 74.72e18 out, and a second run held on the cooldown.
  Also fixed `MockStateView`, which returned a zero price and so covered none of this.

### 2026-09-06 — Vault: the mint's ceiling is the vault's balance, not the enclave's guess

- **Done:** `_mint` passes `got0`/`got1` as the mint's maxima instead of the agent's predicted
  ones. #80 stopped the vault trusting the enclave's `liquidityToMint` and left it trusting the
  enclave's guess about its own balances one line later, so a swap returning *more* of the
  binding token than predicted still reverted with the vault holding plenty. Found by
  @rifkyeasy reviewing #80.
- **AI's role:** wrote the change and the fork test. The reviewer found the gap; the test gap
  was mine — `test_MintsWhatItCanAffordWhenTheAgentAsksForMore` passes `uint128.max` for both
  maxima, so it covered the half I was thinking about and not the other.
- **Plan:** tracked in #87; a one-line change, no separate plan document.
- **Verified:** `forge test` 96 pass with an Arbitrum RPC. Mutation — restoring the agent's
  maxima fails exactly the new test with `MaximumAmountExceeded(1, 87.9e18)`. The first
  mutation attempt reported a false negative because the replacement did not match the
  formatted source; identical gas figures across runs were the tell, and a mutation must be
  confirmed to have applied before its result means anything. Storage layout unchanged.

### 2026-09-06 — The CRE project a judge can actually run

- **Done:** `apps/cre` becomes a real CRE project — `project.yaml`, `secrets.yaml`,
  `workflow/` with the config for the fork and for Arbitrum One, `.env.example`, and
  `rehearse.sh`, which forks Arbitrum One, deploys the vault, mints an out-of-range position,
  commits the mandate and runs the workflow end to end. The scratch Foundry helper from the
  forwarder-delivery plan is committed as `contracts/script/Rehearse.s.sol`.
- **AI's role:** scaffolded from the CLI's own template rather than from memory
  (`cre init -t hello-confidential-workflows-ts`), wrote the script and the docs, ran it, and
  read the result back from the fork. The collaborator wrote the recipe this automates and
  handed the directory over on #21.
- **Plan:** docs/plans/2026-09-06-cre-runnable-project.md
- **Verified:** the run itself, three times. It exposed #78 — the workflow reports a
  transaction hash for a re-centre the forwarder's `try` swallowed, and `positionOf` was
  unchanged. Tested rather than assumed: raising `slippageBps` 50 → 500 moved the requested
  amount 4.4% and left the cap unmoved, which is what says the cap is not a function of the
  budget. The script is left failing on that.

### 2026-09-06 — CRE: an abandoned branch, checked rather than adopted

- **Done:** recovered `fix/cre-swap-inside-the-edge` from a branch left behind on 5 September —
  a one-unit shave off the swap bound, meant to stop a fill landing on the range's exclusive
  upper edge. Landed the test, which states a real invariant, and **not** the arithmetic. The
  vault's own swap passes `sqrtPriceLimitX96 = getSqrtPriceAtTick(tickUpper) - 1`, so the pool
  halts at `tickUpper - 1` whatever the enclave asks for, and a fork test already asserts that
  against the live pool.
- **AI's role:** found the branch while surveying repo state, cherry-picked it, and mutated it
  before believing it. Reverting the change altered no output in any case that could be
  constructed, and the test shipped with it could not tell the two apart either. Wrote the
  comment that records why, so the branch does not get rediscovered and adopted next time.
- **Plan:** none; a comment and a renamed test.
- **Verified:** 117 CRE tests pass. The mutation was confirmed applied by `git diff` before its
  result was trusted, and a probe printed the post-swap price against the edge with and without
  the change — identical to the wei in all three pool depths tried.

### 2026-09-06 — Vault: say the one-position limit out loud

- **Done:** `setMandate` on a second position reverts with `MandateAlreadyActive` instead of
  silently replacing the first, and `contracts/README.md` states the limit and why it exists.
  Closes #53, where a user could be left holding a position they believed was managed and was
  not. Re-committing terms on the same position still works; moving means `revoke()` first.
- **AI's role:** chose the cheap option of the three on the issue and said why the other two
  were wrong here — re-keying accounts by `(owner, tokenId)` changes storage and the mandate
  hash six days before the deadline, and one mandate across many positions cannot work because
  the mandate commits a `poolId`.
- **Plan:** the options are on #53; a guard and four tests did not warrant a separate document.
- **Verified:** `forge test` 89 pass, 10 fork skip without an RPC. Mutation — deleting the guard
  fails exactly `test_ASecondPositionIsRefusedRatherThanSwappedIn` and nothing else. Three
  existing tests were quietly relying on the silent replacement and now `revoke()` first, which
  is the flow a user has.

<!--
Template for the next entry:

### YYYY-MM-DD — <title>
- **Done:**
- **AI's role:**
- **Plan:** docs/plans/<file>.md
- **Verified:** (what was tested, how, and the result)
-->
