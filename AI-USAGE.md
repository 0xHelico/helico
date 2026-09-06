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

<!--
Template for the next entry:

### YYYY-MM-DD — <title>
- **Done:**
- **AI's role:**
- **Plan:** docs/plans/<file>.md
- **Verified:** (what was tested, how, and the result)
-->
