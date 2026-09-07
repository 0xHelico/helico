# @helico/plugin-cre

Chainlink CRE handler that decides, inside a TEE enclave, how much of a `HelicoAccount`'s idle
stablecoin should be earning, **which of the owner's permitted lending markets it should be
earning in**, and how much should stay liquid — and emits the one call that moves it. Plan:
[`cre-manages-idle-capital`](../../../docs/plans/2026-09-08-cre-manages-idle-capital.md).

The account's balances, each market's rate and its available liquidity are all public on chain.
What the enclave keeps confidential is the **policy**: the target split, the buffer the owner
needs on hand to cover a swap against their Aqua mandate, and the deadband below which nothing
moves. Those come from Vault DON secrets and are read only inside the enclave.

## What one run does

Every run (cron trigger, `handlerInTee`):

1. `getSecrets` releases the policy into the enclave. If the owner published
   `keccak256(abi.encode(policy))` in `config.policyHash`, the enclave recomputes it and stops on
   a mismatch **before touching the chain**; a zero hash means nothing was published.
2. Two JSON-RPC batches of `eth_call`, made from inside the enclave, whatever the number of
   markets — comparing them costs more calls, not more waiting. First the account (`agent`, and
   `permittedVenue(pool)` per market), the asset (`balanceOf(account)`), and every market
   (`getReserveAToken`, `getVirtualUnderlyingBalance`, `getReserveData`). Then, in a second
   batch, the receipt token each *market* named: its `balanceOf` and its
   `UNDERLYING_ASSET_ADDRESS`. Asking the receipt which market it belongs to instead reads as the
   same check and is not one — a forged receipt returns the real pool's address and passes.
3. `eligibleVenues` refuses what the account itself would refuse, per market: the owner took this
   venue off the allowlist, it does not list the asset, or its receipt is for a different asset.
   **A refused market is skipped, not fatal** — the rule `_venueFor` follows in
   `HelicoMandateSwap`, because ending the search at a market that cannot serve this account
   strands a usable one further down the list. The one fatal check is `decide`'s first: an account
   that no longer names this agent has nothing for the enclave to decide.
4. `decideIdleMove` sets the target split, applies the deadband, and picks the market — the
   best-paying one to supply to, the worst-paying funded one to withdraw from. `sizeIdleMove`
   clamps the move to what *that* market can actually pay out and to the policy's per-move
   ceiling, and the deadband is applied **again** to the clamped number.
5. Crosses out with the move only, one of two ways. `delivery: 'signature'` (any chain, and what
   both config files use today): the agent key — a Vault DON secret released only into the
   enclave — signs an EIP-712 `IdleMove(IdleMoveParams params, bytes32 policyHash, uint256 nonce)`
   against the account's own domain, and the statement leaves as the DON report and as the
   handler's result, **with the calldata**, for a relayer. `delivery: 'forwarder'`:
   `EVMClient.writeReport` of `abi.encode(bool act, bytes32 policyHash, IdleMoveParams p)` to
   `config.reportReceiver`. A hold signs and writes nothing.

## The decision rule

```
total     = idle + Σ supplied         over every market this run may use
wantIdle  = clamp(max(minIdleAmount, total − total × targetWorkingBps / 10 000), 0, total)
delta     = idle − wantIdle          →  positive: supply,  negative: withdraw
deadband  = max(minMoveAmount, total × minMoveBps / 10 000)
```

Four things in that are load-bearing:

- **The buffer wins over the target share.** `minIdleAmount` is a floor under the idle side, not
  a second target. The account has to be able to cover a swap against its Aqua mandate out of
  what it holds, and a mandate that cannot be covered fails at the moment it is taken — which
  costs more than the yield missed by holding the buffer.
- **The deadband has two halves and a move must clear both.** The absolute half is about gas: a
  move costs the same whatever it moves, so below some size the correction is worth less than
  making it. The relative half is about churn: on a large balance a few dollars clears the gas
  bar easily and still is not a rebalance worth making. Without either, interest accruing every
  block would have the workflow sending a transaction on every run to chase a few basis points.
- **The deadband is applied twice.** The split asks for an amount, then the market's liquidity
  or the per-move ceiling may cut it down; a withdrawal reduced to three dollars because the
  market is drained is exactly the move the deadband exists to refuse, and it only becomes small
  after the clamp.

- **A market that cannot serve the move is skipped, not chosen.** Two conditions and not one,
  because a market can be deep and hold nothing of this account's, or hold the position and be
  drained; and the amount it has to be able to hand back is the bar the move must clear anyway.
  Ranking by rate alone lands on a market that cannot pay and strands a funded one behind it.

`delta` is bounded by construction, not by a later clamp: `wantIdle` is inside `[0, total]`, so
`delta` is inside `[−Σ supplied, idle]` and neither direction can ask for more than the side it
comes out of holds. That bound is across markets, so a withdrawal is clamped again to the
position at the one market it comes out of — only one move leaves per run.

## Choosing between markets, and moving between them

`config.pools` is a list. The enclave reads every market in it, drops the ones the account would
refuse, and then:

| The account is | What happens |
|---|---|
| above the target idle share, by more than the deadband | supply the excess to the **best-paying** market that clears the policy's rate floor |
| below it, by more than the deadband | withdraw from the **worst-paying** market that holds capital and can hand back enough to be worth the move |
| at the target, but holding capital at a market paying materially less than the best | withdraw from the worse market **this** run; the next run's ordinary supply places it at the best |

That last row takes two runs and is not a compromise: `HelicoAccount.nonce` is strictly
sequential, so one signed statement authorises exactly one call. A batch cannot be pre-signed,
and that is the property `invalidateSignatures` depends on.

**A migration clears a higher bar than a rebalance, and both halves of it come from the policy
the owner already set — there is no new secret.**

- **Size doubles.** `minMoveAmount` is what one transaction's gas is worth in this asset. A round
  trip pays it twice, so a migration must be worth `2 × deadband`. That bar is carried through
  the clamp, so a migration cut down by the per-move ceiling is refused where an ordinary
  withdrawal of the same size would go through.
- **The rate gap must clear `minMoveBps`, read as basis points of rate.** A size bar alone cannot
  stop this: a large enough balance clears any of them on a one-basis-point difference, and then
  the account migrates back the first time the two rates cross. `minMoveBps` is the owner's own
  answer to "how small a difference is not worth a transaction", asked of the account's size
  rather than of a rate — so a policy refusing to move less than 0.5% of the account also refuses
  to chase less than 0.5 percentage points of yield. The reuse is deliberate and is written down
  in `decision.ts` rather than left to be discovered.

Neither half is a yield model, and claiming otherwise would be dishonest: pricing a migration
properly needs a holding period — gas is paid once, the gain accrues per unit-second — and
nothing in the policy names one.

Two other consequences worth stating plainly. A market the owner has **un-permitted** takes its
position out of the total: `withdrawIdle` would revert on the same allowlist, so counting it
would set a target against money the agent cannot move. And every market in `pools` must be a
real Aave-family market — one that cannot answer the reads **fails the run** rather than being
skipped, because a view missing a market's rate would pick the best of the rest and call it the
best.

There is **no cooldown**, and that is a consequence rather than an omission: `HelicoAccount`
stores no timestamp of its last move, so the enclave has nothing to read one from. The cron
schedule and the deadband are what limit the rate — and the deadband, unlike a cooldown, gets
harder to clear the closer the account already is to its target.

## What the agent can and cannot do

The account gives the agent exactly two calls, and neither takes a recipient: `supplyIdle`
credits `address(this)` and `withdrawIdle` returns to `address(this)`. So the worst a corrupted
decision, a confused model, or a hostile relayer can do is move the owner's own money between
their own account and a market the owner allowlisted. The agent cannot transfer, cannot approve,
cannot add a venue, and cannot upgrade. Nothing in this package assumes otherwise, and the
`encodeIdleMove` tests assert the shape of the calldata rather than describing it.

## On Arbitrum One

| | |
|---|---|
| CRE chain selector | `ethereum-mainnet-arbitrum-1` |
| `KeystoneForwarder` | `0xF8344CFd5c43616a4366C34E3EEE75af79a74482` |
| Aave v3 `Pool` | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` |
| USDC | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |
| aUSDC, as `getReserveAToken(USDC)` answers | `0x724dc807b04555b71ed48a6896b6F41593b8C637` |

Those three were checked against the live chain with `cast` on 8 September 2026, along with
`getVirtualUnderlyingBalance(USDC)` and the shape of `getReserveData`; the commands are in
[`src/abi.ts`](src/abi.ts).

## Where to look

| | |
|---|---|
| TEE registration, `handlerInTee` | [`src/index.ts`](src/index.ts) `initWorkflow` |
| The enclave callback, steps 1 to 5 | [`src/index.ts`](src/index.ts) `onCronTrigger` |
| The refusals the account would make | [`src/venues.ts`](src/venues.ts) `eligibleVenues` |
| The target split, the deadband and the round trip | [`src/decision.ts`](src/decision.ts) |
| Which markets are usable, and which is best or worst | [`src/venues.ts`](src/venues.ts) |
| Clamping to the market and the ceiling | [`src/sizing.ts`](src/sizing.ts) |
| The policy, its secrets and its hash | [`src/policy.ts`](src/policy.ts) |
| Reads from inside the enclave | [`src/chain.ts`](src/chain.ts) `readAccountState` |
| The signed statement, EIP-712 | [`src/sign.ts`](src/sign.ts) |
| The call a relayer carries | [`src/relay.ts`](src/relay.ts) `encodeIdleMove` |

## Status

| | |
|---|---|
| Registers a TEE handler with `handlerInTee` | ✅ |
| Decision logic is Helico's | ✅ policy hash check, in-enclave reads, target split with a two-part deadband applied before and after clamping, a choice between the owner's permitted markets by live `currentLiquidityRate`, a round-trip bar on migrating between them, a rate floor that gates supplying only, a per-move ceiling |
| Emits the call | ✅ `supplyIdle` / `withdrawIdle` calldata, pinned to `cast calldata`, delivered as a signed EIP-712 statement or as a DON report |
| Delivered on chain | ⚠️ **on a fork, not on a live network.** [`apps/cre/rehearse-idle.sh`](../../../apps/cre/rehearse-idle.sh) forks Arbitrum One, deploys the factory, funds an account with real USDC from a whale, and carries the enclave's signed call to the chain: a run on 8 September moved 40,000 of 50,000 USDC into real Aave v3 and left the agent's own balance at zero. No `HelicoAccount` is deployed on a live network yet, and the simulator is not a TEE |
| Unit tests, `bun test` | ✅ 165 across 9 files: EIP-712 digest and domain separator checked against the spec by hand, the report tuple and the account calldata pinned to `cast`-produced vectors (commands in the tests), the decision table, the deadband boundaries, the market choice and the round-trip bar, and a fake `TeeRuntime` answering `eth_call` by selector |
| Deployed | ❌ deploy access exists on the team's CRE org; the Confidential Workflows private beta is requested (#41) |

## Use

```ts
import { Runner } from '@chainlink/cre-sdk'
import { configSchema, initWorkflow } from '@helico/plugin-cre'

const runner = await Runner.newRunner({ configSchema })
await runner.run(initWorkflow)
```

Config: `{ schedule, rpcUrl, delivery, account, pools, asset, agent, reportReceiver, policyHash,
gasLimit, deadlineSeconds }` — `pools` is a non-empty list of markets with no repeats, and a list
of one behaves exactly as the single-market configuration did — plus, for `delivery: 'signature'`, `chainId` and optionally
`domainName` (`HelicoAccount`), `domainVersion` (`1`), `agentKeySecretId` (`AGENT_KEY`),
`nonceFunction` (`nonce`); for `delivery: 'forwarder'`, `chainSelectorName`. Hex values are
lowercased on parse. `secrets.yaml` must map `IDLE_TARGET_WORKING_BPS`, `IDLE_MIN_IDLE_AMOUNT`,
`IDLE_MIN_MOVE_AMOUNT`, `IDLE_MIN_MOVE_BPS`, `IDLE_MIN_SUPPLY_RATE_RAY`, `IDLE_MAX_MOVE_AMOUNT`
and `IDLE_EXPIRY` to env vars, and in signature mode `AGENT_KEY` to the agent's private key.

## Check

```bash
bun run --filter @helico/plugin-cre typecheck
bun run --filter @helico/plugin-cre test
```

## Do not forget

- The binary is not confidential, only the data it computes over. Never put a balance, an RPC
  response, or the agent key through `usingTheDons()`; the move or the signed statement is the
  whole report.
- **No contract verifies the EIP-712 statement today.** `HelicoAccount` accepts an idle move from
  its agent by `msg.sender`, and its one signature path, `executeWithSignature`, verifies the
  *owner's* `Execute` digest — which this is not and must not become, since a contract that
  accepted an agent's signature there would hand the agent everything `execute` can do. The
  statement is the enclave attesting to what it decided; the calldata beside it is what executes.
- In the simulator the enclave is the simulator, so the agent key is on the machine that runs it.
- Amounts are in the asset's own units. USDC has six decimals, so 25 USDC is `25_000_000`, and
  nothing on chain will catch a factor of a thousand — the account enforces where the money may
  go, never how much of it moves.
- The Uniswap v4 ABIs at the bottom of `src/abi.ts` are the retiring vault path, kept only
  because `apps/app` still imports them (#175). Nothing in the decision reads them.
- The WASM runtime is QuickJS: no `URL` (so no `z.string().url()`), and no `btoa`.
- `runtime.log()` inside the handler is for the simulator. Remove it before deploying.
