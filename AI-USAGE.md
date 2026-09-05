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
| Claude Code | Fable 5.1 | Monorepo tooling — pnpm workspaces, Turborepo, `packages/` scaffold |
| Claude Code | Fable 5.1 | Uniswap plugin (`packages/plugins/uniswap`), its plan, README, and `FEEDBACK.md` |

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

<!--
Template for the next entry:

### YYYY-MM-DD — <title>
- **Done:**
- **AI's role:**
- **Plan:** docs/plans/<file>.md
- **Verified:** (what was tested, how, and the result)
-->
