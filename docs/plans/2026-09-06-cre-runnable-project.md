# The CRE project a judge can actually run

Issue: #21. Handed over by @rifkyeasy on 5 September, because `apps/` is not their side.

## Problem

`apps/cre/` has said *"🚧 Nothing runnable here yet"* since the repository was laid out. The
confidential handler is in `packages/plugins/cre`, and the simulations that produced our
evidence ran from a project on somebody's laptop. So a judge who clones this repository cannot
run the workflow at all, and every number we quote is *"we saw this"* rather than *"here, see
it"*.

Chainlink's qualification text accepts a CRE CLI simulation as evidence. It does not accept a
simulation nobody else can reproduce.

## Approach

The CRE CLI's own layout, from `cre init -t hello-confidential-workflows-ts`, with Helico in
place of the template:

```
apps/cre/
  project.yaml                 RPC per target: local fork, and Arbitrum One
  secrets.yaml                 six mandate fields + the agent key
  .env.example                 their values; .env is gitignored
  workflow/
    workflow.yaml              names and artefact paths
    main.ts                    four lines around @helico/plugin-cre
    config.staging.json        the fork
    config.production.json     Arbitrum One, vault to be filled after a deployment
  rehearse.sh                  the whole run
```

`main.ts` stays four lines on purpose. The workflow is a package, which is why 116 unit tests
can cover the enclave's decision without the CLI in the loop.

`rehearse.sh` turns @rifkyeasy's recipe from `2026-09-05-cre-forwarder-delivery.md` into
something that runs unattended: fork, deploy, fund, mint an out-of-range position, commit the
mandate, rewrite the config with what was just deployed, simulate twice. The scratch Foundry
script quoted in that plan is now committed as `contracts/script/Rehearse.s.sol`, because a
recipe with a `<details>` block in it is not reproducible either.

## What the first run found

The script was written to print a transaction hash, like the CLI does. It was wrong to stop
there.

**`KeystoneForwarder` calls the receiver inside a `try`.** When `onReport` reverts, the
forwarder catches it and the outer transaction still succeeds. The CLI prints
`RECENTER … tx 0x…`, `cast receipt` says `status 1`, and the position has not moved.

So the script now reads `positionOf`, `ownerOf` and `getPositionLiquidity` back from the chain
and replays the transaction with `cast run` when they disagree. That is what turned a green
run into #78 — the enclave's mint maxima are its own estimate with no slippage buffer, so a
swap that lands off the model reverts the whole re-centre with `MaximumAmountExceeded`.

The script is left failing on that, rather than adjusted until it passes.

## How to verify

1. `bun install`, `cp apps/cre/.env.example apps/cre/.env`, `cd apps/cre && ./rehearse.sh`.
2. Steps 1–5 complete: the fork is Arbitrum One at chain id 42161, the vault deploys, and
   `forwarder()` reads back the mock the CLI broadcasts through.
3. The workflow compiles and the simulator announces the TEE it would have run in.
4. Step 6 stops on #78, with the revert printed. When #78 is fixed this run is the evidence
   for #21.

## Not done here

The deployment. `config.production.json` carries a zero vault until there is one.
