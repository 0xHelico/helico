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
| Claude Code | Fable 5.1 | Chainlink CRE plugin scaffold (`packages/plugins/cre`), its plan and README |

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

### 2026-09-05 — Chainlink CRE plugin scaffold

- **Done:** `packages/plugins/cre` (`@helico/plugin-cre`), a reusable package holding the
  confidential handler from Chainlink's `hello-confidential-workflows-ts` template,
  scaffolded with `cre init`. `src/index.ts` is the template's `workflow.ts` unchanged; the
  package layout, tsconfig, tests location, and README are ours. `apps/cre` untouched.
- **AI's role:** researched the CRE docs, the template repository, and Chainlink's agent
  skill first; wrote the plan and its revision, the package layout, and the README; ran the
  checks. The handler logic is Chainlink's, and the README says so.
- **Plan:** [`docs/plans/2026-09-05-plugin-cre.md`](docs/plans/2026-09-05-plugin-cre.md),
  prompts included.
- **Verified:** `pnpm install`, `pnpm --filter @helico/plugin-cre typecheck` (clean), `test`
  (9 pass, 0 fail). WASM compile and `cre workflow simulate` (CLI v1.32.0) verified from a
  throwaway CRE project outside the repo that imports the package: TEE banner shown, result
  `REJECT (score: N, secret reached API: true)`. **Not deployed**: no deploy access on the
  machine's CRE account, and Confidential Workflows is a separate private beta.

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

<!--
Template for the next entry:

### YYYY-MM-DD — <title>
- **Done:**
- **AI's role:**
- **Plan:** docs/plans/<file>.md
- **Verified:** (what was tested, how, and the result)
-->
