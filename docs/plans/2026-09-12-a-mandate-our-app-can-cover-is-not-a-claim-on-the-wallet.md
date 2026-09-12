# A mandate our app can cover is not a claim on the wallet

12 September 2026, 16:40 UTC. Written before the code, as `CLAUDE.md` requires.

## What happened

At 13:54 UTC the one-button flow (#460) shipped a mandate on `HelicoMandateSwap` from the live
account, committing its whole USDC balance — 1,497,196 — and, beside it, the three venue receipts
at the same figure, which is what lets that app settle a fill out of a lending market. At 13:55 UTC
the DON withdrew the account's 490,158 hmUSDC from Morpho (tx `0x6b37141b…`, block 504,414,805).

Replayed with the same pure functions, the production policy and the production subgraph's answer
to `MANDATE_DEMAND`: the index reported one live Aqua balance in USDC that *could demand 1,497,196*,
`withMandateBuffer` raised the liquid floor from 10,000 to that, the target working amount became
zero, and the verdict was `withdraw 490,158`. Without the mandate the same run would have supplied
997,038.

## Why that is wrong for this app, and right for the other

The floor exists for mandates that pull the asset straight out of the wallet — every SwapVM
position does, through `Aqua.pull` on the asset itself. For those, USDC in Morpho is USDC a fill
cannot reach, and holding it liquid is the promise kept.

`HelicoMandateSwap` is built so that promise does not need the wallet. `_cover`
(`contracts/src/HelicoMandateSwap.sol:276`) pulls the *receipt* through Aqua and withdraws the
deficit from the venue inside the same swap. The receipt lines on the mandate are the permission
for exactly that. So for a mandate on this app, capital in a venue is takeable, and pulling it back
to the wallet is the thesis of the product reversed by its own agent.

The enclave cannot tell the two apart today: `MANDATE_DEMAND` sums every active mandate of the
maker in the asset, whatever app it is on.

## The change

Configuration gains `coveringApps`, a list of app addresses whose mandates settle out of venues
and so do not raise the floor. Production lists `HelicoMandateSwap`
`0x0524a353dfab33CD362593ae8e97707764Fb6041`; staging the same, since it rehearses on a fork of
the same chain. Empty by default, which is today's behaviour byte for byte.

`demandHttpRequest` sends a second query, `MANDATE_DEMAND_EXCLUDING`, with
`mandate_: { …, app_not_in: $coveringApps }` when the list is non-empty, and the unchanged
`MANDATE_DEMAND` when it is empty. **Never `app_not_in: []`.** Measured against the live subgraph
before writing this: an empty list matches nothing, which would silently drop every mandate and
leave the floor at the owner's minimum for every maker. That is the one way this change could make
the agent less careful, and a test pins the query chosen for each case.

Measured, same session, on the production subgraph:

| variables | answer |
|---|---|
| our account, USDC, `app_not_in: [HelicoMandateSwap]` | `[]` |
| our account, USDC, `app_not_in: [SwapVM router]` | `[{amount: 1497196, tokensCount: 7}]` |
| a SwapVM maker, WETH, `app_not_in: [HelicoMandateSwap]` | its balance, unchanged |
| our account, USDC, `app_not_in: []` | `[]` — the trap |

## What it does not touch

The contracts, the subgraph, the policy secrets, `policyHash` (the buffer is applied after the hash
is computed, and stays so), the decision arithmetic, the delivery path. A configuration without
`coveringApps` runs exactly as before.

## What the next run will do

With the floor back at 10,000 and 1,497,196 in the account, the split wants 1,487,196 working; the
enclave will supply that to the best-paying permitted venue on the first run after the new build
is active. A third receipt, this time with a live mandate on Aqua beside it.

## Order

1. This plan.
2. `subgraph.ts`: the second query, the config field, the choice; tests for both branches and the
   empty-list refusal.
3. `index.ts`: `coveringApps` in the schema, lowercased like every other address.
4. `config.production.json` and `config.staging.json`.
5. `bun test` in the plugin; `cre workflow simulate` against staging per the runbook.
6. Ghoza deploys with `cre workflow deploy --target production-settings --yes`; record in
   `docs/deployments.md` with the new config hash and the first move it carries.
