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
| Claude Code | Opus 5 | The dapp (`apps/app`), the Go backend (`apps/be`), the landing's nginx, `@helico/plugin-thegraph`, and the READMEs |
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
- **Wording:** "deposit" became "funds" throughout the page at the user's request; grammar fixed by hand.
- **Logos:** the "Built with" grid swaps three wordmarks for logos the user supplied (Ethereum, FREE-PI, One Dollar Audit), converted to lossless webp; the user is asked to confirm the last two were used.
- **Motion:** the canvas loop bug (timer keyed on duration, two neighbours share one) fixed; sections reveal their parts in sequence on first view, JS- and reduced-motion-guarded. Watched headless: the loop returns to Mandate; 53 parts arm and complete; audit at zero.
- **Links:** reading links repointed from GitHub READMEs to docs.helico.site, in the nav and
  every section; code links unchanged. All eight docs URLs checked live, audit at zero.

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

### 2026-09-06 — Landing: container image, VPS, and a deploy on every merge

- **Done:** a read-only security survey of the VPS recorded in
  `docs/plans/2026-09-06-landing-deploy.md`; `apps/landing/Dockerfile` (Bun build, nginx
  unprivileged, cache and security headers, health check) and `.dockerignore`; a workflow that
  publishes the image to GHCR on every merge to `main` and asks Coolify to redeploy; the
  `helico.site` nginx site and certificate on the VPS within the deploy user's granted rights.
  Closes #100 once the Coolify application exists, which only the owner can create.
- **AI's role:** the survey, the files and the server steps. The owner's instruction, verbatim
  in translation, is in the plan.
- **Follow-up:** the forced command now waits for a new container to answer the public URL
  before it returns, so a deploy that never came up fails the workflow; the script is committed
  at `scripts/coolify-deploy.sh`. Both workflows clean their key files with a `trap`.
- **Follow-up (#108):** the deploy call moved from an HTTP bearer token to SSH with a
  forced command on the server; the exposed tokens were revoked. Verified by a run.
- **Follow-up:** the Coolify project and application created through Coolify's API from the
  server, a deploy-only token placed in the repository secrets, the deploy call corrected to
  `POST`, and squash/rebase merging switched off in the repository settings.
- **Verified:** the image built on the VPS and run on a private port: every route 200, 404 on
  a missing page, gzip, immutable cache on hashed assets, headers, non-root nginx, health
  `healthy`; `https://helico.site` answers with a valid certificate (502 until the container
  exists). The SSH password test, the sudo rights and the port list were checked on the box,
  not assumed. The laptop's Docker daemon was not running, so the local check is the server's.

### 2026-09-06 — Backend: the swap conversation

- **Done:** `internal/swap` (a token registry whose addresses were read from Arbitrum One, the
  checks that turn a model's draft into an intent or a refusal, an OpenAI-compatible client, and
  the service that composes its own confirmation sentence), `POST /api/swap/intent` with a rate
  limiter and a 503 when no model is configured, the `BE_LLM_*` and `BE_SWAP_*` settings, and the
  README section. The half of #99 that is not the enclave's; #101 is the other half.
- **AI's role:** wrote it, on the owner's "continue, you execute". The design rule it follows is
  the vault's: the model proposes, the code checks, and an address can only come from the file
  the project committed.
- **Review fixes:** a comma in the amount was read as a thousands separator and turned `0,5`
  into five; the rate limit counted a caller-written header; `BE_LLM_TIMEOUT` could not be
  reached under the request timeout; and the 502 handed the provider's error text out. Each was
  reproduced, fixed, and pinned with a test, including the reviewer's own forged-header probe.
- **Verified:** `go vet`, `gofmt`, `go test -race ./...` across every package; table tests for the
  amount arithmetic and each refusal; a fake model over `httptest` for the endpoint, the 503, the
  429 and the limiter's refill. Then four real messages against `gpt-4o-mini`, including one where
  the model invented a token and the registry refused it — the table is in the plan. Each token
  address was checked on chain with `symbol()` and `decimals()`, which is how the `USD₮0` naming
  came to be written down.

### 2026-09-06 — Backend: the blog API on the VPS

- **Done:** `apps/be/Dockerfile` (static Go build, non-root Alpine runtime, content baked in,
  `/data` volume), a `be` workflow over the SSH forced command, the landing Dockerfile passing
  `BE_URL` at build time; on the server the `api.helico.site` nginx site and certificate, the
  Coolify application with its volume and environment, and the automation's `.env` pointed at
  it. Plan in `docs/plans/2026-09-06-be-deploy.md`.
- **AI's role:** all of it, on the owner's "continue" and the earlier instruction that the API
  would live at `api.helico.site`.
- **Verified:** the image built by Coolify; `/healthz` and `/api/posts` over TLS; a `PUT` with
  the token and the post read back; the landing rebuilt against the API.

### 2026-09-06 — Landing: a Lighthouse pass, and analytics that costs nothing

- **Done:** the audit's one finding fixed (four links reading "Learn More" to four destinations),
  the fonts moved off `fonts.googleapis.com` to this origin, and Google Analytics added, injected
  after `load` rather than placed in the head.
- **AI's role:** ran the audit, read the waterfall, made the changes, measured each one.
- **Verified:** Lighthouse against the live site and then both builds served locally so the
  comparison was fair. Fonts: first paint 2.9s → 2.2s, SEO 92 → 100. Analytics in the head cost
  performance 93 → 74 and largest paint 2.9s → 5.0s; injected after load it measures 98, and a
  browser confirms the tag and the collect beacon both fire.

### 2026-09-06 — CRE: the enclave explains its own verdict
- **Done:** `packages/plugins/cre/src/ai.ts` asks a language model to turn the decision into a
  sentence the position's owner can read, over the HTTP capability from inside the TEE, with the
  router's two credentials released by the Vault DON. It decides nothing — `decide` has already
  chosen and the vault re-checks every rule on chain. Off unless `aiUrl` is set.
- **AI's role:** tested all sixteen non-Grok models on the router against two scenarios and
  picked on the results rather than on reputation; wrote the client, the guards and the tests.
  The user supplied the router and its credentials and asked for reasoning on the LP move.
- **Plan:** docs/plans/2026-09-06-ai-reasoning-in-the-enclave.md
- **Verified:** 181 tests pass. Three guards, each mutated to confirm exactly one test fails
  without it — and the notice guard needed a second test, because the recorded fixture was
  caught by the token guard first and proved nothing about it. Fixtures are real bodies from
  the router, recorded today; every one of them arrived as HTTP 200.

### 2026-09-07 — The dapp: a wallet, and a sentence that becomes a checked intent

- **Done:** `apps/app` — the `vercel/chatbot` template pruned to a chat surface and added to
  the monorepo as a workspace member, Reown AppKit as the only identity (Arbitrum One, email
  and social login switched off), a server route that forwards the sentence to `apps/be` and
  renders exactly what came back, and an intent card that ends by saying signing is not wired
  yet. `ncu -u` inside `apps/app` only.
- **AI's role:** all of it, on the owner's instructions, which are recorded verbatim in
  translation in the plan.
- **Plan:** docs/plans/2026-09-07-app-dapp.md
- **Verified:** in a browser against a local `apps/be` built from the #115 branch with a real
  model key. The Reown modal lists 310 wallets and offers no email field; "Swap half an ETH
  into USDC" comes back as *Swapping 0.5 ETH into USDC on Arbitrum One*; the card shows
  Arbitrum One and `500000000000000000`; the honesty line renders; the console is clean.
  `tsc --noEmit`, `biome check .` and `next build` all pass.

### 2026-09-07 — The dapp does something: the swap executes, the mandate is set, and it is deployed

- **Done:** `bestPoolFor` and `planSwap` in `@helico/plugin-uniswap` (pool, quote, both Permit2
  approvals, calldata, in one call); the vault's user-facing functions, errors and refusal rules
  added to `@helico/plugin-cre` with a test that fails if its ABI and `mandateHash` stop
  describing the same struct; one viem across the workspace; the app's swap card and mandate page;
  a fork fixture that deploys the real vault and hands over a real position; the container image,
  the nginx site, the certificate, the Coolify application and the deploy workflow for
  `app.helico.site`.
- **AI's role:** all of it, on the owner's instruction to make the dapp fully functional and keep
  it maintainable. The instruction and the design decisions are in the plan.
- **Plan:** docs/plans/2026-09-07-app-fully-functional.md
- **Verified:** by running, never by reading. On an anvil fork of Arbitrum One: 0.1 ETH bought
  248.974068 USDC and half came back as 0.049937 ETH through approve → approve → swap. Through a
  browser with a wallet injected: 0.5 ETH became 1244.280761 USDC, and on `/mandate` the rules
  were committed and revoked with the chain agreeing both times. Live:
  `https://app.helico.site` answers 200 on `/` and `/mandate`. Two mistakes are recorded in the
  plan rather than quietly fixed — anvil's default account has code on an Arbitrum fork and
  drains itself, and `bestPoolFor` used to report an unreachable node as an empty pair.
- **Not done, and said so:** the deployed chat answers "the swap service is not answering" until
  #115 merges, and the mandate page says the vault is not deployed until #85.

### 2026-09-07 — The sidebar back, and the session that makes it mean something

- **Done:** the template's shell restored — `SidebarProvider`, the collapsible sidebar with New
  chat above a history grouped by age, and the account block in the footer — plus what it needs
  to be real: EIP-712 sign-in and per-address conversations in `apps/be`
  (`internal/session`, `internal/chat`, nine routes), and the browser's side of them.
- **AI's role:** all of it, on the owner's correction that the shell should match the template
  first and be changed after. The instruction is quoted in the plan.
- **Plan:** docs/plans/2026-09-07-app-sidebar-and-sessions.md
- **Verified:** the digest a wallet signs was computed in Go and in viem and matched byte for
  byte, and that value is pinned in a test — everything else would have agreed with itself even
  if the domain string were wrong. In a browser with a wallet injected: signed in, sent two
  messages, reloaded, and the sidebar showed the conversation with both messages still in it; a
  second wallet in its own context saw none of them. Go tests cover a signature from the wrong
  address, a replayed nonce, a stale one, a tampered payload, a forged cookie, and an
  authenticated stranger trying every chat route.
- **Two bugs the work found rather than review:** turns were ordered by a second-resolution
  timestamp with a random id as the tiebreak, so a question and its answer came back reversed
  about half the time; and the session was a plain hook, so every component had its own copy and
  signing in from the sidebar left the chat still believing it was signed out.

### 2026-09-07 — HelicoMandateSwap, an Aqua app, and the mutation run that judges it

- **Done:** `HelicoMandateSwap` and `IHelicoMandateSwapCallback` — an [1inch Aqua](https://github.com/1inch/aqua)
  app where the strategy *is* a mandate: an expiry, a named agent, and a per-token ceiling on
  what may leave the maker's wallet. Aqua added as a pinned dependency (`v1.0.0`), the compiler
  moved 0.8.28 → 0.8.30 across all 20 files, and 28 tests added. Existing suite untouched:
  89 → 117 passing, 0 failing.
- **AI's role:** all of it, under the owner's instruction to *"build until finished, make sure
  every case is covered — positive, negative and edge."* Three subagents ran first, deliberately
  independent and each told it was free to contradict the plan: one produced the compile recipe
  in an isolated worktree, one specified Aqua's semantics by running its code, and one derived a
  test matrix without seeing ours, asked first for *"which cases would pass even if the feature
  were deleted."*
- **Plan:** docs/plans/2026-09-07-aqua-mandate-swap.md — committed before the contract, and
  amended afterwards with what the review changed rather than rewritten to look prescient.
- **Verified:** every guard was cut out of the contract one at a time and the suite re-run.
  **11 of 11 mutations caught** — ceiling removed, ceiling reading the wrong side, expiry off by
  one, agent gate removed, agent gate always closed, reserves unchecked, fee bound removed,
  identical tokens allowed, reentrancy guard removed, payment check removed, minimum output
  ignored. Each mutation asserts the file actually changed before the suite runs, because a
  mutation that fails to apply is indistinguishable from one nothing catches.
- **What the review changed, and what a test found:** the planned `maxNotionalIn` was the wrong
  limit on the wrong side — either token can be the input, so one scalar means two things, and an
  input ceiling bounds the output only through a curve that can be made to pay out everything.
  Aqua's `ship` validates nothing, so a strategy with a zero reserve on one side is *active*, and
  constant product then returns the whole opposite reserve for two wei. Became `maxOut0`/`maxOut1`
  plus a `DegenerateReserves` refusal. Separately, the suite found that `quoteExactIn` refused
  anyone who was not the agent — the gate belongs on the swap path only; refusing to price a
  mandate protects nothing and breaks routers.
- **Three claims checked rather than assumed:** the aqua tag `v1.0.0` resolves to `81c26e4`, not
  the `9c5c42e` the subagents specified against — the five source files are byte-identical, and
  that was verified through the API rather than trusted. `git rev-parse` inside `lib/aqua`
  answers from the *parent* repo, because `forge install --no-git` removes the `.git`, so the
  first hash it printed was helico's own. And the pinned constant-product literal was recomputed
  in integer arithmetic outside Solidity, because copying a passing run's output would assert
  only that the contract agrees with itself.

### 2026-09-07 — The deploy script, the build that was killing the VPS, and three tracks

- **Done:** `DeployMandateSwap.s.sol` and `ForkMandateSwap.t.sol`, the API image moved off the
  VPS into Actions, `main` un-broken with a guard, and every document realigned to the three
  tracks actually submitted — Chainlink, 1inch, The Graph.
- **AI's role:** all of it, on the owner's decisions: move the builds to Actions, drop Uniswap
  for The Graph, fix everything to match, close what can be closed.
- **Plan:** `docs/deployment.md` for the build move; the demo script was rewritten rather than
  planned separately.
- **Verified:** the Aqua address the script will broadcast to was checked **on chain**, not read
  off 1inch's README — code present, `rawBalances` answers `(0,0)` for an unshipped strategy,
  `safeBalances` reverts with `SafeBalancesForTokenNotInActiveStrategy`. The API image was built
  and *run*: `/healthz` returned ok and `/api/posts` returned content, the second one because
  `.dockerignore` excludes `*.md` with an exception for `apps/be/content`, so a healthy container
  serving an empty blog is a failure a health check reports as fine. Deploy dry run: 1,060,741
  gas, 0.0000426 ETH.
- **The near miss worth recording:** the Aqua address was typed by hand and one character was
  wrong, and **it compiled**. `forge fmt` rewrites an address literal's EIP-55 checksum to match
  whatever hex is present, so solc's mistyped-address check passes on a mistyped address. The
  unit suite could not have caught it — nothing in it touches that constant. The fork suite now
  does.
- **A break nobody caused:** `main` stopped compiling after seven PRs merged. One branch moved the
  tree to solc 0.8.30 for Aqua; another, cut before it, added a file still pinned to 0.8.28. Both
  were green, and **no CI run on either branch could see the other**. Fixed in one line, with
  `scripts/check-pragmas.py` added and verified in both directions against the real break, because
  the category of failure matters more than the instance.
- **What was corrected in someone else's analysis, and in my own:** the case against the 1inch
  track said an Aqua app "requires their SwapVM contracts". It does not — `SwapVM` is not an
  `AquaApp` and the string appears zero times in that repository. And a claim that #101 was still
  failing was four hours older than its fix; I nearly repeated it as current.

### 2026-09-07 — The Graph: a subgraph, a client, and paging that was silently wrong

- **Done:** `subgraph/` indexing Aqua on Arbitrum One (#156), `@helico/plugin-thegraph` (#157,
  #162), the maker-mandates query the whole track rests on, and `scripts/check-subgraph.ts`.
- **AI's role:** all of the client and the check script, on the owner's instruction to deploy the
  subgraph and wire it up. `@ghozzza` wrote the subgraph handlers and reviewed the client.
- **Verified:** the client was run against the live Studio endpoint and its numbers compared
  field by field against Aqua's own `rawBalances` — ten balances, zero mismatched, including two
  docked mandates reporting `tokensCount 255`. The client and the subgraph agreeing proves less
  than that comparison does, because both can be consistently wrong together.
- **Two traps, both silent, both now tested:** the subgraph stores addresses lower-cased, so a
  checksummed one matches nothing and returns an **empty list rather than an error** — a maker
  with fifty mandates reads as a maker with none. And `Number('16577240263528345757')` returns a
  number, just not the one on chain; amounts are `bigint` end to end. The test for that is
  written against strings, because a wrong literal in a test is exactly as lossy as wrong code —
  both of us independently wrote that assertion the wrong way first.
- **A defect I shipped and @ghozzza found:** `makerMandates` took `first = 100` and returned
  whatever came back, so a maker with 150 mandates got 100 of them, silently, and the caller
  sized what an agent may spend against a portfolio it could not see all of. Fixed in #167 by
  following pages until one comes back short. Their diagnosis included the part I had not
  thought about: the query must be top-level `mandates(where:)` rather than
  `maker(id:) { mandates }`, because a nested list caps at 100 with no `pageInfo` and no cursor,
  so nothing in that response distinguishes 100 mandates from 100 of 5000.
- **A collision worth recording:** we built the same module in parallel within the same hour.
  Mine merged first by timing, not by merit; theirs had the paging and better typing. #161 was
  closed and the two improvements it carried were landed separately (#167, #171) rather than
  dropped.

### 2026-09-07 — Execution evidence for CRE, and a video pre-flight that found a wrong sentence

- **Done:** `docs/evidence/2026-09-07-cre-rehearsal.md` (#158), closing #21; and a pre-flight of
  every shot in the demo script (#159).
- **AI's role:** ran `apps/cre/rehearse.sh` end to end, recorded the transcript, and checked its
  numbers against the mandate rather than quoting them.
- **Verified:** the position had genuinely drifted (tick 96165 against a range of 94960..95160);
  the new range is what `decision.ts` computes from `rangeWidthTicks` to the tick; 9427 bps of
  liquidity retained against a floor of 5000; the vault kept nothing; a second run returned
  `HOLD (cooldown)`. **The check that matters is the position id moving** — the forwarder calls
  the vault inside a `try`, so a reverting `onReport` still leaves a green transaction.
- **Stated plainly in the document, because overclaiming is a disqualification:** the simulator
  is not a TEE, the mock forwarder verifies no DON signatures, nothing is deployed, and the AI
  explanation step **did not run** — `config.staging.json` sets `aiUrl` so the call was attempted
  and failed on `.env.example`'s placeholder credentials. That is the designed behaviour and it
  is what a judge cloning the repository will see, so it is what the document shows.
- **The pre-flight found a sentence that would have cost a take:** shot 3 asks for the maker's
  balances on screen, and its fallback said to run the fork test at `-vv`. At `-vv` that test
  prints one green `[PASS]` line and nothing else. The shot and its own fallback disagreed, and
  the way to discover that, as written, was mid-take.

### 2026-09-07 — The Aqua we had been building against was dead

- **Done:** `subgraph.yaml` and the deploy script re-pointed (#166, and @ghozzza's #170),
  `CLAUDE.md` updated with 1inch's answer on scope (#163), and `@helico/plugin-1inch` (#168).
- **AI's role:** found it, verified it four ways, and wrote the plugin. The decision about what
  to do with the 1inch track is the owner's and @ghozzza's.
- **How it was found:** while testing whether a concentrated position could be shipped through
  1inch's SwapVM, a quote reverted with `SafeBalancesForTokenNotInActiveStrategy` naming a
  strategy hash Aqua had **just stored** and that `rawBalances` read back. A contract cannot fail
  to find a balance it holds — unless it is a different contract.
- **Verified:** `@1inch/aqua-sdk` exports `AQUA_CONTRACT_ADDRESSES[42161]` as
  `0x1111113ccf…`; the deployed `AquaSwapVMRouter` carries that address in its bytecode and has
  no reference to `0x499943E7…`; the two have different bytecode and the live one answers
  `owner()` while the old one reverts; `eth_getLogs` over 400,000,000 → head gives 1,289 logs on
  the old one, newest block 451,737,844, against 1,590 on the live one, newest 502,646,947.
  @ghozzza independently confirmed the address with 1inch in `#partner-1inch`.
- **The lesson, and it is about a check recorded in this file as passing:** the previous entry
  says the address was *"checked on chain, not read off 1inch's README"* — code present,
  `rawBalances` answering, `safeBalances` reverting correctly. Every one of those was true, and
  **both contracts pass all three**, because both are real Aqua deployments. The address had been
  found by scanning `eth_getLogs` forward for a contract emitting Aqua's events, and scanning for
  a contract that behaves like Aqua finds a contract that behaves like Aqua. It cannot tell you
  whether anyone still uses it. Behavioural verification was necessary and not sufficient; the
  vendor's own SDK constant was the check that decides.
- **`@helico/plugin-1inch`, and three more silent failures:** the concentrate price is a ratio of
  **raw** amounts, so ETH at $2,800 against 6-decimal USDC is `2800e6` — passing `2800e18` quoted
  at `$2,808,428,656,082,635` with zero output and **did not revert**. Which token is the
  numerator is decided by comparing addresses as numbers, so it flips between chains for the same
  pair. And `ship` takes the encoded order, not the bare program, because Aqua hashes the bytes
  it is handed while SwapVM looks the balance up under the order's hash.
- **Evidence, reproducible:** `scripts/check-aqua.ts` on a fork ships three concentrated
  positions from one wallet — three Aqua events each, **zero token transfers**, wallet
  byte-identical afterwards, 300% committed against what it holds, and all three quoting at
  prices that spread the way concentration should ($2,967.26 / $2,989.53 / $2,584.81).
- **Corrected in review of @ghozzza's #170:** the NatSpec said the canonical Aqua "carries none"
  of the activity. `1,289` for the stale one was exact; the other half inverted the evidence.
  Both contracts are active, which is why activity cannot separate them and why the partner's own
  word was needed.

### 2026-09-08 — a twelve-agent audit, the account architecture, and moving CRE off the old product

- **Done:** `HelicoAccountFactory`, `HelicoAccountProxy`, `HelicoAccount` and `AccountAuth`; the
  venue fixes the audit produced; the CRE workflow rewritten from re-centring liquidity to
  managing idle capital; `rehearse-idle.sh`, which runs that end to end on a fork.
- **AI's role, and it differed by task:**
  - **Twelve independent Opus agents** ran the `solidity-auditor` skill from `pashov/skills`
    (version 3) over `HelicoMandateSwap.sol` and `ILendingVenue.sol`. Nine single-specialty, three
    hunting the seams between specialties. The instruction was the skill's own: attack the code,
    and without concrete proof it is a lead rather than a finding.
  - **The account contracts were written in this session**, from a plan committed before the code
    (`docs/plans/2026-09-08-account-factory.md`, `2026-09-08-one-account-per-owner.md`).
  - **The CRE rewrite and the multi-venue selection were delegated** to agents given a written
    spec that fixed the design decisions in advance — one move per run because the account's
    nonce is sequential, the deadband applied to a round trip rather than each leg — so the agent
    implemented a design rather than inventing one.
- **Plan:** `docs/plans/2026-09-08-cre-manages-idle-capital.md`, and the two above.
- **Verified:** 159 local tests and the fork suite against live Arbitrum. `rehearse-idle.sh` exits
  0: the factory deploys, an account opens at an address computed before it existed, 50,000 USDC
  arrives from a whale on the fork, the enclave answers `SUPPLY 40000000000`, and the account ends
  holding 39,999.999999 aUSDC against a 10,000 buffer. The agent's own balance is zero.

**What the audit found, and what the audit could not.** Four defects, and every one of them was a
rule already written in the file's own NatSpec that the code did not keep. They survived because
every mandate in the test suite shipped `venues: new Venue[](0)` — the whole unwind path was
reached by no test, so twenty-eight green tests said nothing about it.

The step that turned a finding into a fact was not the twelve agents. It was removing the fix and
watching what moved: with the pool binding gone, a swap that should have been refused **succeeded**
and 90.66 of another party's receipt tokens left the contract. A test that passes with the fix in
place has not been shown to catch anything.

**Three corrections made by humans, recorded because they are the pattern.** @rifkyeasy found a
NatSpec claim that ships and is checkable and false — that the canonical Aqua carried no events —
and separately that `HelicoAccount` sat outside the storage-layout check while being the more
dangerous of the two contracts to shift. @ghozzza found that we had described 1inch's `main` README
as stale when the stale thing was our own choice to pin a March tag.

All three are the same shape: a claim stated with more confidence than the measurement behind it.
It appeared often enough in one day that the operational defaults are now in `CLAUDE.md`, and one
of them — running Solidity's format check before push instead of only in CI — became a git hook,
because a lesson written down was violated again within the hour and a hook does not need to be
remembered.

### 2026-09-08 — the dapp off the vault, a subgraph cache, and three local-run bugs

Fourteen pull requests in one session, in `apps/app`, `apps/be`, `apps/landing`,
`packages/plugins/` and the READMEs. **Nothing in `contracts/` or `apps/cre` was touched** —
Ghoza fenced those two directories for this session, and the fence held, including for their
READMEs.

- **Done, by pull request:**
  - **The dapp stops being built on a vault that will not exist.** #219 replaced the
    "point this at the vault" form on the front page with the account's two owner-only limits
    (`setAgent`, `permitVenue`); #205 added the button that opens an account; #229 moved the
    chat's two non-swap answers onto the account and the subgraph and deleted `lib/vault.ts`.
    `HelicoVault` now has no surface in the app (#175).
  - **A cache in front of Subgraph Studio** (#214): `POST /api/graph` in `apps/be`, which
    forwards a `{query, variables}` body and remembers the answer for a minute. It knows no
    GraphQL beyond the operation name — the queries stay in `@helico/plugin-thegraph` — and the
    browser falls back to Studio when it is absent.
  - **Three bugs that made a local run unusable** (#207, #209, #216): the app pointed at the
    production API, so a `SameSite=Lax` cookie was set and never sent again; the session key was
    regenerated on every boot; and every run needed four assignments typed in front of it.
  - **Security headers** (#221, #231): the landing declared five and sent two, because nginx
    discards inherited `add_header` in any `location` that sets one of its own. And a content
    policy for the dapp, shipped report-only — see below.
  - **The portfolio reads what it claimed to read** (#211): the summary's total was
    `{factory ? "—" : "—"}` under a permanent "Reading the account…", with no account query in
    the component at all.
  - **Copy and documentation** (#223, #228): the READMEs went from 1,154 lines to 834 with every
    pinned permalink intact, and the two pages stopped explaining themselves at four levels of
    heading.

- **AI's role:** Claude Code (Opus 5) wrote all fourteen branches, with Ghoza directing each in a
  sentence or two — *"kenapa tiap refresh harus sign lagi?"*, *"buat semua readme simple, singkat,
  on point"*, *"di app terlalu banyak deskripsi"*. Two design decisions were Ghoza's and were
  followed rather than argued: keep the chat rather than replace it with a market agent, and keep
  the portfolio separate from the mandate page. One was overruled in the other direction — #202
  asked for the relayer to sponsor `open()`, and the pull request argues for the owner's own
  wallet instead and says why, rather than doing it quietly.

- **Reviewing a teammate's work was part of it.** #212 was read line by line rather than approved:
  the signing path still bound the EIP-712 domain to `config.account`, which that same pull
  request made default to the zero address — so every signature in the intended production
  configuration would have been unusable. 236 tests passed over it, because every fleet test gave
  its accounts identical balances so the tie went to the anchor, and the signing test asserted the
  same wrong expression the code computed. Ghoza fixed the line and the harness; the fix was then
  verified by restoring the bug and checking that exactly one test failed.

- **Plans:** this session ran from issues rather than plan files — #202, #203, #206, #208, #210,
  #213, #215, #227 were each written before their branch and each states what would be verified.

- **Verified:** every pull request carries its own evidence and none was merged on a red or
  pending check. Across the session: the 31 browser checks (32 after #231) on a production build
  against a local backend; `go test ./...`, `go vet`, `gofmt`; `turbo run test typecheck lint`;
  `next build`. Beyond the suites — `setAgent` and `permitVenue` were exercised against the
  **deployed** factory on an Arbitrum fork with the exact ABI strings the UI sends, confirming
  `venueEverPermitted` stays true after a revoke; the subgraph cache was checked against the live
  Studio endpoint for `X-Cache: miss` then `hit`, and a `403` for an unlisted operation; and the
  session key was proved to survive a restart by hashing it across two boots.

- **One claim deliberately weakened after testing it.** The content policy in #231 was built from
  measured traffic, and the browser checks were made to fail on any violation. Then the guard
  itself was tested, by deleting `api.web3modal.org` from the allow-list — **and the checks still
  passed**, because nothing they do asks that origin. So the policy ships as
  `Content-Security-Policy-Report-Only`, with only `frame-ancestors` enforced. A guard that cannot
  fail is not a guard, and enforcing a list with a known hole three days before the demo video
  would risk the one flow the submission depends on.

### 2026-09-08 — the secret the DON would not serve, a full rehearsal, and deleting the vault

- **Done:** the deployed CRE workflow had failed at secret retrieval on **every** run since it
  went up. Fixed, redeployed, and running: `13:45:02 UTC SUCCESS`, then `13:50:02 UTC SUCCESS`,
  against three failures before it. Then the whole workflow was rehearsed end to end on a fork of
  Arbitrum One, and `HelicoVault` with the Uniswap v4 contracts was deleted — 21 files, 5,102
  lines.

- **AI's role:** Ghoza directed the work in conversation and made the calls that mattered — turn
  the model on in the rehearsal, delete what will not ship, and (earlier) set the idle floor to
  zero. Claude did the diagnosis, the code, and the measurements, and was corrected twice.

- **The diagnosis, because the shape of the evidence is the whole answer.** Three hypotheses died
  first: that the batch was too large (eleven and ten failed identically), that the namespace was
  wrong (a run with it set explicitly failed the same way, and the error had been printing the
  namespace all along), and that the manifest was incomplete (`workflow unchanged; re-deployment
  skipped` proved it is not part of the deployed artifact). What identified it was splitting into
  one call per secret — the shape Chainlink's own reference names for TypeScript — and watching
  **call 0 succeed and call 1 fail**, twice, on one binary. The compiled SDK then closed it:

  ```js
  getSecret(request) { const c = this.getSecrets([secretRequest]) }   // a batch of one
  const id = this.nextCallId; this.nextCallId++                       // inside getSecrets
  ```

  There is no separate singular path — every retrieval is a batch, and what separates them is the
  callback id. That is the number production had been printing: `for call 0`, `for call 1`. Not
  the first and second *secret*; the first and second *callback*. One is answered per execution.
  So all eleven values now travel as one JSON item, unpacked inside the enclave.

- **A test fake that refuses.** The fake runtime now refuses a second retrieval the way the DON
  does. Without that, a change back to one-call-per-secret passes the suite and fails on chain —
  the exact bug the new shape exists to prevent. Mutating the code back turns **68 tests red**.

- **Two tests changed meaning rather than wording.** *"forwarder delivery never asks for the agent
  key"* cannot be observed once one request carries everything; spelled that way it would pass
  without anything happening. It now asserts what it was protecting — that a forwarder run needs
  no key at all.

- **Corrected, in public, after asserting it:** Claude reported that the model had misquoted a
  policy figure by a factor of ten. It had not. The number was the effective threshold for that
  account, not the constant it was compared against, and the arithmetic said so:
  `max(minMove, total × minMoveBps / 10000)`. A guard built on that misreading was reverted rather
  than kept with its reasoning patched. All six figures in the model's explanation were then
  checked against their sources and all six were right.

- **One mistake worth recording:** the script that packs the secrets was written with a default
  path. It defaulted to the wrong file and packed test values, which would have uploaded cleanly —
  valid JSON, all eleven ids present, and no component in the chain able to notice. It was caught
  only because two runs differed by twelve bytes. The path is now a required argument, and the
  script refuses a file that does not carry the marker identifying the right one.

- **Found while deleting, and unrelated to the deletion:** `HelicoAccount`'s contract-level
  docblock said upgrades were *"announced first, executable only after a delay, expiring after a
  grace period"* and cancellable by the owner. `_authorizeUpgrade` does none of that, and its own
  docblock 330 lines below said so plainly. The file asserted both, and the reassuring one was at
  the top. Both now describe the code.

- **Plans:** no plan file. The session ran from [#234](https://github.com/0xHelico/helico/issues/234),
  opened before the work, and from conversation recorded here.

- **Verified:** `bun test packages/plugins/cre` (244 pass), `forge build`, `forge test` (89 pass,
  0 fail), `FOUNDRY_PROFILE=swapvm forge build`, `forge fmt --check`, `bun run check` /
  `typecheck` / `test`, and five python checks including one repointed at `HelicoAccount` and
  mutation-tested by flipping `executeBatch` to payable in the artifact and watching it fail.
  Beyond the suites: **the full workflow on a fork of Arbitrum One with the model on** — 50,000
  USDC funded, `SUPPLY 40,000` decided, EIP-712 signed, the call carried to the chain, working
  balance `0 → 39,999,999,999` (Aave rounds the aToken down by one unit), and the agent ending the
  run holding **0 USDC**. The simulator is not a TEE, so this shows the workflow compiles for the
  CRE runtime, reads the chain, decides, signs, and that the signed call lands and moves capital.
  It does not show DON authorisation or enclave attestation.

- **A record corrected.** `docs/deployments.md` said the workflow *"holds, every run, correctly."*
  Every run was failing at secret retrieval and never reached the logic that would have held. The
  line described the code's intent rather than the deployment's behaviour, which is the one thing
  a deployment record must not do. It now carries the execution list instead.

### 2026-09-09 — the one-sided maker, and the two apps built to serve them

- **Done:** the whole product ran end to end on a fork in one command — an account opened
  *through the app* on the deployed factory, managed by the enclave, capital moved. Then a
  question from Ghoza turned into two new Aqua apps: one to answer it, one to act on the answer.

- **AI's role:** Ghoza asked the questions and made every call — build it now rather than after
  submission, keep the deck private, delete what will not ship. Claude did the reading,
  the code and the measurements, and was corrected twice on things it had asserted.

- **The question, and why it needed an answer rather than an opinion.** *"Can I put up only USDC,
  without ETH?"* `HelicoMandateSwap` refuses a zero side with `DegenerateReserves`, so the easy
  answer is no. The real answer needed the distinction between our app and the protocol:

  ```
  amountOut = amountIn * balanceOut / (balanceIn + amountIn)
  ```

  With `balanceIn == 0` the `amountIn` cancels top and bottom and the whole opposite side leaves
  for two wei. That is a fact about **our curve**. Aqua prices nothing at all — eighty-one lines,
  no `price`, no `quote`, no curve — which was verified by reading the vendored source rather than
  by trusting our own comment that said so.

- **So it was tested rather than argued.** `test/FixedPriceBoard.sol` is the smallest app that
  reads its price from a field instead of a ratio. Two answers came back, and the second is the
  one worth having: naming only USDC fails for a **bookkeeping** reason — `ship` sets
  `tokensCount` from `tokens.length`, so a token never named reverts every read that touches it —
  while naming both and giving one of them **zero** works, and the maker's capital stays 100%
  USDC.

- **Then the answer was built on.** A fixed price serves a one-sided maker but never brakes, so a
  market that moves converts the whole position at yesterday's number.
  `HelicoOracleBoard` takes the price from Chainlink's live ETH/USD feed and the brake from Aqua's
  own ledger — both quotes shift down as inventory accumulates, so selling in gets worse and
  buying it back gets better. That is what a constant product gets for free, restored on top of a
  feed that knows nothing about who holds what.

- **Corrected, in public, after asserting it.** Claude reported *"Test-nya sudah masuk, PR #257"*.
  There was no PR #257 — `gh pr create` had never been run. The number was arithmetic from "the
  last one was 256", presented as a fact. It surfaced two hours later when a different piece of
  work was assigned that number. Recorded, with the check that would have caught it: a PR number
  must come from the command that made or read the PR, never from a pattern.

- **A green assertion that proved nothing**, found before it was committed: a test read the ask
  price *after* the fill and compared it with itself. It passed for that reason. Now both quotes
  are read before.

- **Plans:** no plan file. The session ran from conversation and from
  [#234](https://github.com/0xHelico/helico/issues/234), recorded here as it happened.

- **Verified:** `forge test` — **108 passed, 0 failed**, including six fork tests against the live
  Chainlink feed and four against Aqua. The inventory brake is mutation-checked: forcing the skew
  to zero turns the bend test red and leaves the other five green, so the test is specific to what
  it names. `forge fmt --check`, `bun run check` / `typecheck` / `test`, and five python checks.
  The deploy script was dry-run against Arbitrum One rather than only compiled.

  Beyond the suites, the end-to-end rehearsal on a fork of Arbitrum One:

  ```
  app opened the account   0xBCb6c913…fC77   on the deployed factory, by pressing a button
  nominated the agent      0x84C3891a…5fcAf  from the page, not from a script
  funded                   5,000 USDC
  the enclave decided      SUPPLY 4,000 to Aave v3
  sent as the agent        working  0 -> 3,999,999,999
                           idle     1,000,000,000
  the agent's own USDC     0
  ```

  Its first run reported **success while having failed**: `${VAR,,}` is bash 4 and macOS ships
  3.2, and the exit code read belonged to `tail` at the end of the pipe. Both fixed, and the
  second reason is a rule this repository already had.

- **The deployed workflow, meanwhile:** twenty consecutive `SUCCESS`, five minutes apart, holding
  correctly because no account exists on the live chain for it to manage.

### 2026-09-09 — context for the chat, the door nobody could open, and a number that was the control

- **Done:** the chat learned what Helico is and started showing the checks behind each answer; the
  escape hatch — the one path an upgrade cannot remove — got a sentence, a button and a proof on a
  fork; `api.helico.site` stopped being the only unhardened origin; and the README stopped
  presenting a control measurement as its headline result.

- **AI's role:** Ghoza directed with six short messages and made every call about scope. Claude did
  the reading, the code and the measurements, was wrong twice in public, and had one of its own
  pull requests closed in favour of a better one from Ghoza.

- **Plan:** none of these has a file in `docs/plans/`. The design lived in the issues — #263, #266,
  #272, #275 — and the ordering was not uniform, which is the part worth recording rather than
  smoothing over. Checked against the commits:

  | | issue | first commit | order |
  |---|---|---|---|
  | #266 escape hatch | 13:50 | 14:01 | design first, by 11 minutes |
  | #272 API headers | 14:20 | 14:22 | design first |
  | #275 README | 14:37 | 14:39 | design first |
  | #263 chat context | 13:40:25 | 13:40:45 | **code first**, the issue written from what was found |

- **The prompts, in full.** Translated, as the entries above do. This was the whole of the
  direction:

  > *"Please give it context about our app so it knows."*
  > *"Could the reasoning/thinking tree be shown?"*
  > *"Try looking deeper — it seems it can do LP too."* … *"Not Uniswap, 1inch Aqua."*
  > *"And is there anything else Helico can do? If so, implement that as well."*
  > *"Aqua has been tested by my friend and it is proven."*
  > *"Check issues/PRs and continue."* (five times)

- **The chat answered its own question back.** *"hi"* returned *"What can I help you with?"* because
  the system prompt said only *"you decide which of three things a person is asking for"* — a
  greeting had no action to fall into, landed on `swap` with every field empty, and what the person
  read was the model's own `question` field. The fix is a fourth action whose reply is **composed in
  Go**: a model handed a paragraph about the product offers to bridge and to borrow, and a partner
  integration that does not work is a full disqualification. The reply asks the token registry for
  its symbols instead of repeating them, so `tokens.go` stays the only list.

- **The checks tree is the functions that actually ran**, appended inside `build` where the work
  happens rather than assembled by a caller from the outcome — a list built from the result can name
  a check that never executed. So a refusal ends on the check that refused it:
  `Chain.Token "MOONCOIN" is not in the registry — refused`.

- **`rg escape apps/ packages/` returned nothing.** The invariant `CLAUDE.md` calls the door nobody
  can wall up had no button, no ABI entry and no sentence — while the empty chat screen had offered
  *"Take everything back to my wallet"* above a comment promising every sentence there could be
  answered. That sentence went to `revoke`, which removes the agent and moves no money. Someone
  asking for their money got agreement and no money.

- **Verified:** three Go tests pin `withdraw` against `revoke`; two more pin the API headers and
  both go red when the one line adding the middleware is removed. `apps/app/e2e/fork-account.ts`
  gained a fifth step and runs the whole path on a fork of Arbitrum One — twelve checks, the last
  two reading the chain:

  ```
  ok  the account holds USDC before the sweep  — 5000000
  ok  saying it in the chat offers the sweep, not the revoke button
  ok  the sweep empties the account  — 0 left
  ok  and the owner is up by exactly what it held  — 5000000
  ```

  The account is funded by a **real transfer** from Aave's aUSDC contract, not by writing a balance
  into storage — a sweep out of an account that could never have been paid into proves nothing
  about one that can, which is a mistake this repository has made before.

  The API hardening was measured after deploying rather than after merging:
  `e2e/production.ts` went from 20 checks to 23, all green, against the live sites.

- **Wrong twice, in public.** Issue #265 proposed pairing SwapVM's `concentrate` with our
  `AquaYieldCover` as a two-instruction program. Reading the sources rather than guessing,
  `concentrate` requires the swap amounts **unset** and the cover reads the amount the swap
  **computed** — so no two-instruction program holds both, and the composition is three. The issue
  also worried that `_computeL` would race the cover for available balance; it does not, because
  concentrate adds *virtual* reserves and never wanted the unwound inventory. Ghozza found both,
  and the correction is the useful part of #274 rather than a footnote to it.

  The second was a merge on a red `verify`. The gate printed the conclusions and merged anyway,
  which is the fourth time in this repository. The pattern that actually gates is a count computed
  and branched on in the same command, and it is now written into the review on #270.

- **A pull request closed in favour of a better one.** #271 and #270 fixed the same broken test.
  Ghoza's was thirty seconds older and added the half mine was missing — that every action the
  backend *does* send is accepted. A refusal list on its own says nothing about whether anything
  gets through.

### 2026-09-09 — the documentation site, recorded here because the product links to it

- **Done:** `docs.helico.site` is a separate Next.js application, built
  on 6 September from the `tailwind-variants-docs` template and rebranded for Helico — nineteen
  documentation pages written from this repository's READMEs and plans, plus a `Dockerfile` and a
  deploy workflow. It is linked from the landing in seven components (`Hero`, `Nav`, `Footer`,
  `Faq`, `Build`, `Verified`, `Enforcement`) and from the dapp's connect gate, so a reader of this
  submission arrives there by following the product.

- **AI's role:** all of it, under Ghoza's direction — *"build the docs from this template, change
  everything to fit Helico, take the metadata from the landing, deploy it to the VPS with CI/CD on
  docs.helico.site with certbot."* Every factual sentence is taken from this repository's own
  documentation, and the caveats travel with the claims.

- **Why it is recorded here.** The site deploys from its own repository and its own pipeline, so
  none of the work on it appears in this repository's history. This is the repository connected to
  the submission, and the attribution requirement asks where AI was used rather than which
  repository it was used in — so a site the product's primary call to action points at belongs in
  this log.

- **Verified:** read rather than remembered. The eight link sites from `grep -rn docs.helico.site`
  in this repository, and the nineteen pages counted in the documentation source.

### 2026-09-09 — the afternoon: two surfaces that said the opposite of the truth, and a box that kept dying

- **Done:** the landing and the documentation site stopped claiming nothing was live; the chat
  learned to answer for the product rather than for itself, to carry its own history, and to
  follow its own replies down the page; and the VPS was diagnosed and its two fixable causes
  fixed.

- **AI's role:** Ghoza directed by screenshot, mostly in single sentences. Claude did the reading,
  the code, the measurement, and was wrong twice in ways the measurements caught.

- **Plan:** none in `docs/plans/`. The design lived in issues #275, #281, #284, #289 and #103, and
  the ordering held for those — each was written before its code, unlike #263 this morning.

- **And four more documentation changes the same morning**, recorded here for the reason the entry
  above gives: the site deploys from elsewhere, so none of this lands in this repository's history.
  All four are AI-written under Ghoza's direction:

  | | | |
  |---|---|---|
  | #5 | 06:13 | pages for the two submitted tracks that had none |
  | #6 | 09:06 | five contracts are deployed, and six pages said nothing was |
  | #7 | 09:10 | 227, because the vault-era tests went with the vault |
  | #8 | 09:46 | plainer words, no em dashes, and the product we actually build |

  Their prompts are not reproduced here because they were given in that project's own session and
  this file does not invent them. What is knowable from here: #6 and #7 are the documentation
  catching up to deployments and to a test count that had moved, and #8 is the same "less AI, more
  human, no em dashes" direction quoted above, applied to the docs rather than the landing.

- **The prompts, in full.** Translated, as the entries above do:

  > *"Make the language on the landing and docs less AI, more general and human, and no em dashes."*
  > *"Remove Base and Robinhood from Built with, change Built with to Built on, add the ETHGlobal logo top left."* … *"Remove Arbitrum too."* … *"Not in the nav next to the logo, delete the ETHGlobal in the nav."*
  > *"In Built in the Open, focus on the Aqua code."* … *"Only show three cards."*
  > *"This is too long"* (twice, about copy I had lengthened).
  > *"The UI is ugly, can there be a token logo then the token name then the balance, and the number font in Arizona."*
  > *"Still answer it — show the balance and the token list, do not just tell me to go and check."*
  > *"When sending a message the view should follow the new one down, not stay at the top."*
  > *"Previous messages should be context for the next one."*
  > *"Helico can do lots of things, why only Swap, Status, Revoke and Withdraw?"*
  > *"Check why the VPS went down earlier."* … *"Fix it so it does not happen again."*

- **Both public surfaces said "nothing is live yet"** while five contracts answered on Arbitrum One.
  It survived in six documentation pages including `llms-txt.mdx`, which instructs anything quoting
  the docs to repeat the caveat — so an assistant reading us would have told somebody the project
  had deployed nothing. Understating is not the safe direction; it is as false as an overclaim and
  nobody re-reads a modest sentence looking for errors. The landing's headline number was worse
  than stale: "94% kept working" measured Uniswap v4 range re-centring, a path CRE left on
  8 September.

- **56 em dashes went, and one stayed.** `Powered by SwapVM — © Degensoft Ltd 2025` is the
  attribution their licence requires verbatim. Two were inside code blocks because
  `scripts/check-aqua.ts` **prints** one; that was fixed at the source rather than at the quote, so
  the docs still match what the script outputs.

- **"Can you provide liquidity?" got four bullets that did not mention liquidity.** The reply
  listed what the chat reaches; the question was what Helico does. It now names the other screens
  and ends with what it cannot do at all. The test guarding it searched for forbidden words, which
  blocked the honest version — naming a thing you cannot do requires saying its name — and now
  checks where the word falls instead.

- **Wrong twice, and the measurements are what said so.** `executeBatch` cannot reach the account's
  own owner-only functions, because the batch runs each call **as the account**; proved on a fork
  after nearly shipping a button built on the opposite assumption, which moved #291 to EIP-5792.
  And the chat's autoscroll was written twice against scroll **position** before the third version
  used the reader's **intent**: a smooth scroll is still animating when a card resizes, so a
  position check lands mid-flight and reads as somebody who scrolled away. 327 of 447, twice, then
  447 of 447.

- **The VPS was stopped mid-build again**, and the journal proves it came from outside: the log
  ends mid-sentence with zero OOM kills and zero panics in the whole boot. Two of our
  contributions were fixable and are fixed — three deploy workflows shared one queue instead of
  three, and the deploy script now reclaims cache above 70% and refuses above 92%. The age-filtered
  reclaim freed 0B against 7.9 GB reclaimable, which is why it escalates; the unfiltered pass took
  the disk from 87% to 78%. What is not fixed needs Coolify write access: every deploy builds the
  image **twice**, once in Actions and once on the box, and only the second one can crash it.

- **Verified:** every claim above read from the thing rather than remembered. `eth_getCode` and
  `eth_call` for the deployments, `journalctl -b -1` for the crash, `docker ps --format` for what
  the containers actually run, and a browser driven against a fork of Arbitrum One for each UI
  change, with the scroll position and the history length read out of the page. Production checked
  after deploying rather than after merging: 23 of 23.

### 2026-09-09 — the evening: an account nobody had to open first, and an answer nobody read

- **Done:** three things, all reported by Ghoza against the running app. Typing `p` in the chat
  came back demanding three fields nobody had mentioned; the account had to be deployed by its own
  button before any limit could be set; and "what can you do" answered with four bullets inside
  four paragraphs.

- **AI's role:** wrote all of it, and the interesting part is where each fix landed rather than
  what it says.

  The `p` bug had two candidate homes. The model's instructions said *"when it is clearly none of
  the five, use swap"*, which forces nonsense onto the one path that then asks for parameters —
  that line is now `about`. But a prompt cannot be tested, and the model kept answering `"swap"`
  with three empty fields even after the change, so the fix that actually runs is four lines in
  `Interpret`: a draft naming no token and no amount is not a swap request, whatever label came
  back with it. Proved by pointing the backend at a fake OpenAI endpoint that reproduces the exact
  reported draft.

  Auto-open turned out to be smaller than the "gas sponsor" it looked like. The relayer path is
  real — `executeWithSignature` and `factory.executeDigest` exist, the relayer key holds 0.005 ETH,
  and `open` has no access control at all — but `apps/be` has keccak and secp256k1 and no
  transaction signer, no RLP, no chain client, so a sponsored open means writing one two days
  before the recording. It is also not needed: `open` is idempotent and permissionless, so the
  write that needs an account can simply make one first. `openFirst()` runs in front of both
  setters, and the EIP-5792 batch prepends it, which turns a new account and both its limits into
  one confirmation.

  That made the panel's own button a second way to do the same thing for an extra transaction, and
  the two paths cannot both be exercised in one run — whichever goes first leaves nothing for the
  other to open. The button went, and the fork test now presses **Nominate** against an account
  that does not exist.

  The help answer became six cards, and the shape is enforced rather than described: a card
  carries a sentence to send **or** a screen to open, never both and never neither, so a card that
  is only a bordered bullet fails the test. The swap card's token tags are the registry's own
  symbols, which is why nothing in the browser holds a copy of that list.

- **Verified:** the fork run is the evidence for the account change and it was rewritten to be
  falsifiable — it now asserts `isOpen == false` *before* pressing anything, so a build where the
  write does not open the account fails on the next line instead of passing quietly. Thirteen of
  thirteen against a fork of Arbitrum One, including a real USDC transfer and the sweep. The card
  test was checked by poisoning it: a card offering "borrowing" makes it fail, which is the only
  reason its passing means anything. Backend suite green, `tsc` and Biome clean, and every screen
  above read from a browser driven against the fork rather than from the diff.

### 2026-09-09 — a mandate that leaves Solidity, and a deployment that was a day behind

- **Done:** Ghoza reported that Helico can now do LP on Aqua, Earn on Aave and Compound, and
  transfer, and that a teammate said "mandate" was no longer relevant. Asked to validate rather
  than accept, three of the four turned out not to hold, and the check that settled it was the
  deployed subgraph: `mandates(where: {app: "0xa16d…87ed"})` returns `[]`, while every mandate it
  indexes belongs to 1inch's own apps. So no maker has ever shipped to our app.

  Compound was the one worth catching. `ReceiptMath.SharePriced` handles a cToken-shaped receipt,
  but only inside `HelicoMandateSwap` when unwinding a maker's position, and only against a mock —
  no fork test names Compound. Meanwhile `HelicoAccount.supplyIdle` calls
  `supply(address,uint256,address,uint16)`, which is Aave v3's signature; Comet's takes two
  arguments. `ILendingVenue.sol` says so out loud: *"adding Compound or Morpho later"*. Claiming it
  in the video is the category that costs a submission.

  Then built the part that was genuinely missing. `@helico/plugin-1inch` had `shipCall`, hardcoded
  to 1inch's SwapVM router, and no `SwapMandate` encoder anywhere — so the mandate half of the
  1inch track had never left Foundry.

- **AI's role:** wrote the encoder, the setup calldata, and the fork check. Two decisions are worth
  recording.

  The first is what the encoder is checked against. A `SwapMandate` encoded wrong by one field does
  not revert: Aqua files a position under `keccak256` of the raw bytes, the app recomputes the hash
  from the struct it is handed, and a mismatch means the ship succeeds and files under a hash
  nobody looks up. A unit test of my encoder against my own decoder would pass either way, so the
  real check is an `eth_call` to the contract's own `mandateHash` — and it runs first, with the
  script refusing to continue if it disagrees.

  The second is what that check found. It reverted, which a `pure` function cannot do, so the
  selector had to be wrong: today's struct hashes to `0x5344635d` and the deployed bytecode
  contains `0xbeb513da`. **`HelicoMandateSwap` on Arbitrum One is a day and a feature behind the
  source in this repository** — it was deployed on 8 September, `ReceiptKind` widened `Venue` on 9
  September. Nothing is broken; the deployment is simply older than the tests, and a mandate
  written today would miss the function rather than fail loudly. That is now an assertion in the
  script and a warning in `docs/deployments.md` and beside the address itself, rather than
  something the next person rediscovers.

  Not written: `contracts/script/DeployPayingTaker.s.sol`, which I had offered. `contracts/` is
  ghozzza's, the redeploy is a bigger part of that task than the taker, and both are one issue for
  them rather than a file from me.

- **Verified:** seventeen checks against a fork of Arbitrum One, with real Aqua, real USDC, real
  Aave v3 and real WETH. An account opened through the deployed factory, 2,000 USDC supplied to
  Aave, a mandate shipped from the account through `executeBatch` with every byte built by the
  plugin, the ledger read back under the account rather than the owner, and the wallet byte-identical
  afterwards because shipping moves nothing. Then two fills: 0.1 WETH for 271.98 USDC out of the
  wallet with Aave untouched, and 2 WETH for 1,758.13 USDC against 728.02 idle, which unwound the
  position to 969.88. The second one is the product's own sentence, measured.

  Three of those checks failed first and each failure was mine: a rounding tolerance one unit too
  tight, a second fill sized before thinking about the curve — 0.4 WETH quotes *less* than 0.1 did
  once the price has moved — and a check named for an unwind that had not happened. The last was
  the one worth fixing rather than deleting, because it would have passed forever without ever
  testing what it claimed.

### 2026-09-09 — the check that would have caught the bug a day earlier

- **Done:** added three assertions to `apps/app/e2e/production.ts`, which exercised the landing,
  the dapp's gate, the security headers and the subgraph cache, and never once touched the chat.

- **AI's role:** wrote them. The point is which failure they would have caught: #305 was live for a
  day, and the production suite passed the whole time, because the one thing a judge types first
  was the one thing nothing watched. One model call per run sends a message naming no token and no
  amount, and asserts what it was read as, that the answer carries cards, and that every card is
  pressable — a sentence to send or a screen to open, exactly one of the two.

- **Verified:** 26 of 26 against the live deployment after the backend rolled out, and the two
  messages from Ghoza's report answered from production rather than from a local build: `p` and
  "bisa lp kah?" both come back as `about` with six cards. The browser was driven against
  `app.helico.site` as well, because an API that answers correctly is not the same as a page that
  draws it.

### 2026-09-09 — marks on the swap card, and naming the pool it uses

- **Done:** Ghoza asked why the chat's swap goes through Uniswap when the submission pivoted away
  from it, and asked for chain and token logos.

- **AI's role:** checked the first before changing anything, because the answer decides whether the
  second is polish or camouflage. The swap is Uniswap v4 through `@helico/plugin-uniswap`, and it
  is the only swap a browser wallet can do today: `HelicoMandateSwap` is maker-side, it needs a
  mandate somebody shipped, and `IHelicoMandateSwapCallback` means a taker has to be a contract. So
  it is not a leftover, and #125 kept the v4 code tested on purpose — what the pivot removed was
  the claim, not the code.

  The card said "Pool — 0.05% fee tier, no hook" and never said whose pool. In a submission whose
  tracks are Chainlink, 1inch and The Graph, that is the one line a reader wants stated rather than
  inferred, so it now reads "Uniswap v4 · 0.05% fee tier, no hook".

  Then the marks. `TokenMark` already drew every token in the registry and the portfolio used it;
  the swap card rendered the same tokens as bare symbols. `ChainMark` is new and shares Arbitrum's
  artwork with the ARB token deliberately — Arbitrum uses one mark for both — but carries its own
  accessible name, because sharing the label would say a chain is a token. An unknown chain gets
  nothing rather than a guess: a wrong network mark on a transaction someone is about to sign is
  worse than no mark.

- **Verified:** driven in a browser against a fork of Arbitrum One, with the marks, the chain row
  and the named pool read off the rendered page. The account e2e was re-run and passed 13 of 13,
  which is what catches a shared component broken by a refactor. One failure on the way was the
  fixture rather than the code: the local fake model classified the withdrawal sentence as `about`,
  so the sweep button never appeared — the fake learned the other four actions, and the run went
  green without the app changing.

<!--
Template for the next entry:

### YYYY-MM-DD — <title>
- **Done:**
- **AI's role:**
- **Plan:** docs/plans/<file>.md
- **Verified:** (what was tested, how, and the result)
-->
