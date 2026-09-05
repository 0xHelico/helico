# Chainlink CRE plugin — confidential workflow scaffold

Issue: [#3](https://github.com/0xHelico/helico/issues/3)

## Problem

Helico intends to use Chainlink CRE, and the Chainlink prize at ETHOnline 2026 requires a
workflow that **registers and uses a confidential TEE handler** (`handlerInTee`) and runs a
*meaningful part* of the application inside it. Nothing CRE-related exists in the repository
yet, and the team convention is `packages/plugins/<name>` for partner integrations.

The product logic Helico will eventually run inside the enclave is not decided. So the first
step is a scaffold that is **proven to compile, test, and simulate** on a clean checkout, with
its status stated honestly, so the real logic can be dropped in later without touching the
tooling.

## Approach

Scaffold `packages/plugins/cre` (`@helico/plugin-cre`) from Chainlink's official
`hello-confidential-workflows-ts` template using `cre init`, then fold it into the pnpm
workspace.

The template already does the four things the prize checks for:

1. `cre.handlerInTee(trigger, fn, tees)` registers the handler to run in an enclave
2. `runtime.getSecret()` fetches a Vault DON secret inside the enclave
3. `HTTPClient.sendRequest(teeRuntime, ...)` calls an API from inside the enclave
4. `runtime.usingTheDons()` crosses back to the Workflow DON for a signed report

### Layout

```
packages/plugins/cre/            CRE project root — and the pnpm workspace package
├── package.json                 @helico/plugin-cre: deps + scripts (test, typecheck, simulate)
├── project.yaml                 targets + RPCs (from the template)
├── secrets.yaml                 secret id -> env var mapping
├── .env.example                 what to put in the gitignored .env
├── tsconfig.json                extends the repo base; `types: []` because the runtime is WASM, not Node
├── README.md                    how to run it, and what is and is not proven
└── workflow/
    ├── main.ts                  entry point compiled to WASM
    ├── workflow.ts              the handler
    ├── workflow.test.ts         bun tests with a fake TeeRuntime
    ├── workflow.yaml            workflow name, artifact paths, deployment-registry: private
    ├── config.staging.json
    └── config.production.json
```

One `package.json` at the project root instead of the template's `workflow/package.json`, so
the plugin is a single workspace member and `pnpm install` from the repo root installs it.
Module resolution from `workflow/` walks up to the root `node_modules`, which is normal.

### Rejected alternatives

- **Put it in `apps/cre/`.** The team decided partner integrations live under
  `packages/plugins/`. `apps/cre` stays as it is until the team decides what, if anything,
  goes there.
- **Hand-write the files.** Chainlink's own agent guidance says to always scaffold with
  `cre init` and only hand-write as a fallback. `cre init` works here, so it is used.
- **Start from `ai-audit-firewall` or `automated-liquidation-protection`.** Those encode a
  specific product. Helico's product is not decided, so they would be a fake fit.
- **HTTP trigger instead of cron.** Probably what a plugin invoked by an app wants, but
  `handlerInTee` with an HTTP trigger is not something the official templates exercise.
  Cron is the proven path; switch once the app's shape is known.
- **Latest SDK (`1.19.1`).** The template pins `@chainlink/cre-sdk@1.18.0` and was updated
  two days before this plan. Keep the pinned, known-good pair (CLI v1.32.0 + SDK 1.18.0).

## Scope

**In**

- `cre init --non-interactive -t hello-confidential-workflows-ts --deployment-registry private`
- Move into `packages/plugins/cre`, single `package.json`, tsconfig extending the base
- `deployment-registry: "private"` under `user-workflow` in `workflow.yaml` (the
  Chainlink-hosted registry: no wallet, no gas). It must sit under `user-workflow`, not
  `workflow-artifacts`, or it is silently ignored.
- Rename the workflow to `helico-cre-staging` / `helico-cre-production`
- Plugin README, layout tables, `AI-USAGE.md` entry

**Out**

- Deployment. Two separate gates: CRE *deploy access* (the account on this machine shows
  `Not enabled`) and the *Confidential Workflows private beta* (invite-only, separate form).
  Simulation needs neither.
- Any Helico-specific decision logic. The template's `scoreResponse` is a placeholder.
- On-chain delivery of the report (`writeReport`) and a consumer contract.
- A mock API server. The template calls `postman-echo.com`, which needs no key.

## How to verify

All from the repository root, on a clean checkout, with `.env` copied from
`packages/plugins/cre/.env.example` and `SECRET_API_TOKEN` set to any non-empty string:

| Step | Command | Pass condition |
|---|---|---|
| 1 | `pnpm install` | resolves; `cre-setup` has produced the javy toolchain |
| 2 | `pnpm --filter @helico/plugin-cre typecheck` | `tsc --noEmit` clean |
| 3 | `pnpm --filter @helico/plugin-cre test` | every `bun test` case green |
| 4 | `pnpm --filter @helico/plugin-cre simulate` | simulator prints the TEE banner, then `APPROVE`/`REJECT (score: N, secret reached API: true)` |

Step 4 is the real gate: it compiles to WASM with the actual CLI and runs the handler with a
simulated enclave. `secret reached API: true` proves the secret was fetched inside the TEE
path and reached the outbound request.

If step 4 fails only because of the single-`package.json` layout (bin resolution from
`workflow/`), fall back to the template's own layout (`workflow/package.json`, installed with
`bun install --cwd workflow`) and record that in this plan.

## Facts checked during research

- CRE CLI was v1.2.0 on this machine, latest is v1.32.0 (released 2026-09-03). Updated with
  `cre update`. `--non-interactive` is a global flag on the new CLI.
- `cre init` and `cre templates list` call the GitHub API unauthenticated and hit
  `403 Forbidden` (rate limit), reported as "network unavailable". Setting
  `GITHUB_TOKEN=$(gh auth token)` fixes it.
- Template source: `smartcontractkit/cre-templates` @ `d0223f3` (2026-09-03).
  The generated `workflow.ts` is byte-identical to upstream `main`.
- SDK `@chainlink/cre-sdk` requires `bun >= 1.2.21`; installed bun is 1.3.14.
- Chainlink publishes an agent skill (`chainlink-cre-skill`); its scaffolding, simulation,
  and confidential-workflow references were read and followed.
- Sources: https://docs.chain.link/cre-templates/hello-confidential-workflows ·
  https://docs.chain.link/cre/guides/workflow/using-confidential-workflows/making-workflow-confidential-ts ·
  https://docs.chain.link/cre/account/confidential-workflows-access ·
  https://github.com/smartcontractkit/chainlink-agent-skills

## Prompts

The instructions that produced this plan, verbatim (Indonesian) with an English gloss:

> pertama coba buat plugin-cre dong — ini docsnya — https://docs.chain.link/cre

*"First, try building plugin-cre. Here are the docs."*

> kamu research dulu yg banyak ya baru eksekusi

*"Do a lot of research first, then execute."*

Standing instructions from earlier in the same session that shaped the process: open an
issue, leave one comment, then branch and PR; never commit straight to `main`; always pull
first.

## Revision — same day, after the first scaffold passed

The first cut put the whole CRE project (project.yaml, workflow dir, simulate script) under
`packages/plugins/cre`. The user then narrowed it:

> untuk usage nya di apps/cre

*"Its usage goes in `apps/cre`."*

> cuma ini buat packages doang/reusable package

*"This one is only for `packages`, a reusable package."*

> pastikan setiap readme intinya aja jangan bertele tele

*"Keep every README to the point."*

So the scope of this PR is the **reusable package only**:

- `packages/plugins/cre` exports `configSchema`, `initWorkflow`, `onCronTrigger` from
  `src/index.ts` (the template's `workflow.ts`, unchanged) and ships the `bun test` suite.
- `apps/cre` is untouched. Wiring the package into a runnable CRE project there is a
  separate task.
- Verification of step 4 (WASM compile + simulate) therefore ran from a **throwaway CRE
  project outside the repository** that depends on the package through `file:`. It is not
  committed. Steps 1–3 run in the repo as written.
