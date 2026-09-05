# @helico/plugin-cre

Chainlink CRE handler that decides, inside a TEE enclave, whether a Uniswap v4 LP position
should be re-centred, and delivers the decision to `HelicoVault` as a signed DON report. The
mandate itself is public on-chain (`setMandate` takes it in calldata), so what the enclave keeps
confidential is the decision process: which position it watches, when it reads, the RPC traffic,
and the sizing of the mint. The mandate hash in the report proves consistency, not secrecy: the
enclave decided against the mandate the vault holds right now.
Plans: [`cre-mandate-decision`](../../../docs/plans/2026-09-05-cre-mandate-decision.md),
[`cre-vault-alignment`](../../../docs/plans/2026-09-05-cre-vault-alignment.md),
[`cre-forwarder-delivery`](../../../docs/plans/2026-09-05-cre-forwarder-delivery.md).

Every run (cron trigger, `handlerInTee`):

1. `getSecrets` releases the mandate's thresholds from the Vault DON into the enclave; the
   enclave recomputes `keccak256(abi.encode(Mandate))` and stops if it differs from
   `config.mandateHash`, before touching the chain.
2. Two JSON-RPC batches of `eth_call`, made from inside the enclave: the account from the vault
   (`positionOf`, `lastActionAt`, `isActive`), `StateView.getSlot0`, then the position's
   liquidity and range from the `PositionManager`. The chain is the source of truth.
3. `decideRecentre`: hold on expiry, cooldown, or while in range; otherwise a range of exactly
   `rangeWidthTicks` centred on the tick, emitted only if `vaultRejects`, a mirror of
   `HelicoVault._checkRange`, would accept it.
4. `sizeRecentre`: what the burn returns at the current price and the liquidity that buys over
   the new range (Uniswap's arithmetic on native `BigInt`), scaled by `slippageBps`. Below the
   mandate's `minRetainedBps` of the old liquidity it holds rather than mint dust.
5. `deliver`: `runtime.report(...)` over `abi.encode(bool act, bytes32 mandateHash, RecenterParams p)`
   and `EVMClient.writeReport` to the vault on `chainSelectorName`. A hold writes nothing.

## Known gap, found here

An out-of-range position holds a single token, and a single token cannot fund a range that
contains the price. The vault's plan is burn-and-mint with no swap, so for the product's core
case the enclave holds (`the burn cannot fund the new range without a swap`); the numbers are on
#37. Until the vault swaps, or the product narrows to re-centring while still in range, no
re-centre is delivered.

## Where to look

| | |
|---|---|
| TEE registration, `handlerInTee` | [`src/index.ts#L196-L204`](src/index.ts#L196-L204) |
| The enclave callback, steps 1 to 5 | [`src/index.ts#L137-L172`](src/index.ts#L137-L172) |
| Policy and sizing on the chain state | [`src/index.ts#L88-L134`](src/index.ts#L88-L134) `decide` |
| Report to the vault through the forwarder | [`src/index.ts#L175-L193`](src/index.ts#L175-L193) `deliver` |
| Reads from inside the enclave | [`src/chain.ts#L91-L167`](src/chain.ts#L91-L167) `readChainState` |
| Mandate struct and hash | [`src/mandate.ts`](src/mandate.ts) |
| The vault's range rule, mirrored | [`src/decision.ts`](src/decision.ts) `vaultRejects` |
| Uniswap arithmetic, cross-checked against the SDK | [`src/math.ts`](src/math.ts), [`src/sizing.ts`](src/sizing.ts) |

## Status

| | |
|---|---|
| Registers a TEE handler with `handlerInTee` | ✅ |
| Decision logic is Helico's | ✅ mandate hash check, in-enclave reads, re-centre rule aligned with the vault, mint sizing |
| Delivers the verdict to the vault | ✅ code and tests; **not yet run against a deployed vault** (the vault's `onReport` is #37, contract side) |
| Unit tests, `bun test` | ✅ 74: hash vector cross-checked with `cast`, decision table and grid, arithmetic against `@uniswap/v3-sdk`, fake `TeeRuntime` answering `eth_call` by selector and recording `writeReport` |
| Compiles to WASM and simulates in the CRE simulator | ✅ for the decision (#33, #36); the read-and-deliver path needs a vault on the testnet first |
| Deployed | ❌ needs CRE deploy access **and** the Confidential Workflows private beta; the on-chain run will be `cre workflow simulate --broadcast` through the `MockKeystoneForwarder` |

## Use

```ts
import { Runner } from '@chainlink/cre-sdk'
import { configSchema, initWorkflow } from '@helico/plugin-cre'

const runner = await Runner.newRunner({ configSchema })
await runner.run(initWorkflow)
```

Config: `{ schedule, rpcUrl, chainSelectorName, vault, positionManager, stateView, owner, poolId,
mandateHash, gasLimit, slippageBps, deadlineSeconds }`. `secrets.yaml` must map
`MANDATE_RANGE_WIDTH_TICKS`, `MANDATE_MIN_IMPROVEMENT_BPS`, `MANDATE_COOLDOWN_SECONDS`,
`MANDATE_MAX_LIQUIDITY`, `MANDATE_EXPIRY`, `MANDATE_MIN_RETAINED_BPS` to env vars, with the same
values the user passed to `setMandate`. Any chain with a v4 `StateView` and a CRE forwarder works; on Robinhood that is
the testnet (`robinhood-testnet`).

## Check

```bash
bun run --filter @helico/plugin-cre typecheck
bun run --filter @helico/plugin-cre test
```

## Do not forget

- The binary is not confidential, only the data it computes over. Never put the tick or the
  RPC response through `usingTheDons()`; the verdict is the whole report.
- `vaultRejects` and the `RecenterParams` tuple in `abi.ts` must change whenever the vault does. `rangeWidthTicks` is a
  width in ticks and `minImprovementBps` is a relative shrink of the gap to the range's
  centre; the contract defines both.
- The WASM runtime is QuickJS: no `URL` (so no `z.string().url()`), and a negative `int24`
  must be passed to viem as a `bigint`.
- `runtime.log()` inside the handler is for the simulator. Remove it before deploying.
