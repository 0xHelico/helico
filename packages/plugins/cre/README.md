# @helico/plugin-cre

The Chainlink CRE handler. Inside a TEE enclave it decides how much of an account's idle
stablecoin should be earning, **which of the owner's permitted markets it should earn in**, and how
much must stay liquid — then emits the one call that moves it.

Balances, rates and market liquidity are public on chain. What stays in the enclave is the
**policy**: the target split, the buffer the owner needs on hand to cover a swap against their Aqua
mandate, and the deadband below which nothing moves. Those are Vault DON secrets.

Plan: [`cre-manages-idle-capital`](../../../docs/plans/2026-09-08-cre-manages-idle-capital.md).

## What one run does

1. **Release the policy.** If the owner published `keccak256(abi.encode(policy))` in
   `config.policyHash`, the enclave recomputes it and stops on a mismatch *before touching the
   chain*.
2. **Read the chain**, in two batched `eth_call` rounds however many markets there are: the
   account and the asset, then the receipt token each *market* named. Asking the receipt which
   market it belongs to reads like the same check and is not one — a forged receipt returns the
   real pool's address and passes.
3. **Ask The Graph** what this account's live Aqua mandates could still be asked to pay out, and
   raise the liquid buffer to it. That number has no on-chain answer. The floor may only be
   **raised**, so an index that is down, empty or behind leaves the run with the owner's own
   `minIdleAmount` and says which buffer it used.
4. **Decide.** Target split, deadband, then pick the market — best-paying to supply into,
   worst-paying funded one to withdraw from. Size the move, clamp it to what that market can
   actually pay and to the per-move ceiling, then apply the deadband *again*.
5. **Cross back out with the move only.** Either an EIP-712 statement signed by the agent key, or
   a DON report to a forwarder. A hold signs and writes nothing.

## The rule

```
minIdle   = max(policy.minIdleAmount, Σ Balance.amount)   spendable, this asset, live mandates
total     = idle + Σ supplied                             over every market this run may use
wantIdle  = clamp(max(minIdle, total − total × targetWorkingBps / 10 000), 0, total)
delta     = idle − wantIdle          →  positive: supply,  negative: withdraw
deadband  = max(minMoveAmount, total × minMoveBps / 10 000)
```

**The buffer beats the target share.** A mandate that cannot be covered fails at the moment it is
taken, which costs more than the yield missed by holding the buffer. And the mandates size that
buffer, so shipping a larger one moves the floor up with it.

**The deadband has two halves.** The absolute half is gas — a move costs the same whatever it
moves. The relative half is churn — on a large balance a few dollars clears the gas bar and still
is not a rebalance worth making. Without either, interest accruing every block would have the
workflow sending a transaction on every run.

**It is applied twice.** A withdrawal cut to three dollars because the market is drained is exactly
what the deadband exists to refuse, and it only becomes small after the clamp.

**A market that cannot serve the move is skipped, not chosen.** It can be deep and hold nothing of
this account's, or hold the position and be drained. Ranking by rate alone lands on one that cannot
pay and strands a funded one behind it.

## Choosing between markets

| The account is | What happens |
|---|---|
| above the target idle share, past the deadband | supply the excess to the **best-paying** market clearing the rate floor |
| below it, past the deadband | withdraw from the **worst-paying** funded market that can hand back enough |
| at the target, but parked somewhere paying materially less | withdraw from the worse market **this** run; the next run's ordinary supply places it at the best |

That last row takes two runs and is not a compromise. `HelicoAccount.nonce` is strictly sequential,
so one signed statement authorises exactly one call — a batch cannot be pre-signed, which is the
property `invalidateSignatures` depends on.

A migration clears a higher bar: a round trip pays gas twice, so it must be worth `2 × deadband`.
No new secret — both halves come from the policy the owner already set.

## What the agent cannot do

The account gives it two calls and **neither takes a recipient**: `supplyIdle` credits
`address(this)`, `withdrawIdle` returns to `address(this)`. So the worst a corrupted decision, a
confused model or a hostile relayer can do is move the owner's own money between their own account
and a market the owner allowlisted. It cannot transfer, approve, add a venue, or upgrade.

## Where to look

| | |
|---|---|
| `handlerInTee`, and the enclave callback | [`src/index.ts`](src/index.ts) — `initWorkflow`, `onCronTrigger` |
| The split, the deadband, the round-trip bar | [`src/decision.ts`](src/decision.ts) |
| Which markets are usable, and which is best | [`src/venues.ts`](src/venues.ts) |
| Clamping to the market and the ceiling | [`src/sizing.ts`](src/sizing.ts) |
| The policy, its secrets and its hash | [`src/policy.ts`](src/policy.ts) |
| Reads from inside the enclave | [`src/chain.ts`](src/chain.ts) |
| The Aqua mandates behind the buffer | [`src/subgraph.ts`](src/subgraph.ts) |
| The signed statement, and the call a relayer carries | [`src/sign.ts`](src/sign.ts), [`src/relay.ts`](src/relay.ts) |

## Status

| | |
|---|---|
| Registers a TEE handler with `handlerInTee` | ✅ |
| The decision is ours | ✅ policy hash, in-enclave reads, two-part deadband applied twice, a buffer sized from live Aqua mandates, a choice between permitted markets by live rate, a round-trip bar, a rate floor, a per-move ceiling |
| Emits the call | ✅ `supplyIdle` / `withdrawIdle` calldata pinned to `cast calldata`, as a signed EIP-712 statement or a DON report |
| Delivered on chain | ⚠️ **on a fork, not a live network.** [`rehearse-idle.sh`](../../../apps/cre/rehearse-idle.sh) forks Arbitrum One, funds an account with real USDC from a whale, and lands the enclave's signed call: 40,000 of 50,000 USDC into real Aave v3, agent balance zero at the end. The simulator is not a TEE |
| Unit tests | ✅ 239 across 10 files — EIP-712 digests checked against the spec by hand, calldata pinned to `cast` vectors, the decision table, deadband boundaries, market choice, and every way a subgraph answer can fail |
| Deployed | ❌ Confidential Workflows private beta requested (#41) |

## Use

```ts
import { Runner } from '@chainlink/cre-sdk'
import { configSchema, initWorkflow } from '@helico/plugin-cre'

const runner = await Runner.newRunner({ configSchema })
await runner.run(initWorkflow)
```

`pools` is a non-empty list with no repeats; a list of one behaves as the single-market
configuration did. Leave `subgraphUrl` empty to skip the buffer step, exactly as an empty `aiUrl`
skips the model. `secrets.yaml` maps the `IDLE_*` policy variables, and `AGENT_KEY` in signature
mode.

```bash
bun run --filter @helico/plugin-cre typecheck
bun run --filter @helico/plugin-cre test
```

## Do not forget

- **The binary is not confidential, only the data.** Never put a balance, an RPC response or the
  agent key through `usingTheDons()` — the move or the signed statement is the whole report.
- **No contract verifies the EIP-712 statement today.** The account accepts an idle move from its
  agent by `msg.sender`. Its one signature path verifies the *owner's* digest, which this is not
  and must not become: a contract accepting an agent's signature there would hand the agent
  everything `execute` can do.
- In the simulator the enclave *is* the simulator, so the agent key sits on the machine running it.
- Amounts are in the asset's own units. USDC has six decimals, and nothing on chain catches a
  factor of a thousand — the account enforces where money may go, never how much moves.
- The WASM runtime is QuickJS: no `URL` (so no `z.string().url()`), no `btoa`.
- `runtime.log()` is for the simulator. Remove it before deploying.
