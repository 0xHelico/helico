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
   (`positionOf`, `lastActionAt`, `isActive`), the pool's price, fee, and active liquidity from
   `StateView`, then the position's liquidity and range from the `PositionManager`. The chain is
   the source of truth. A pool whose LP fee is above `maxPoolFeePips` is refused.
3. `decideRecentre`: hold on expiry, cooldown, or while in range; otherwise a range of exactly
   `rangeWidthTicks` centred on the tick, emitted only if `vaultRejects`, a mirror of
   `HelicoVault._checkRange`, would accept it.
4. `sizeRecentre`: what the burn returns at the current price, the swap that turns the excess
   token into what the new range wants (estimated at the pool's active liquidity, bounded so the
   price stays inside the new range), and the liquidity the result funds; Uniswap's own
   arithmetic on native `BigInt`, scaled by `slippageBps`. A zero mint, or one below the
   mandate's `minRetainedBps` of the old liquidity, is a hold.
5. `deliver`: `runtime.report(...)` over `abi.encode(bool act, bytes32 mandateHash, RecenterParams p)`
   and `EVMClient.writeReport` to the vault on `chainSelectorName`. A hold writes nothing.

## Why there is a swap in the report

An out-of-range position holds a single token, and a single token cannot fund a range that
contains the price (numbers on #42). So the report carries `zeroForOne`, `amountIn`, and
`minAmountOut` and the vault swaps through the position's own pool inside its unlock before it
mints. Until that vault lands, a re-centre on a pool with no liquidity to swap against is a
hold (`NothingToMint`).

## Where to look

| | |
|---|---|
| TEE registration, `handlerInTee` | [`src/index.ts#L220-L228`](src/index.ts#L220-L228) |
| The enclave callback, steps 1 to 5 | [`src/index.ts#L161-L196`](src/index.ts#L161-L196) |
| Policy and sizing on the chain state | [`src/index.ts#L99-L158`](src/index.ts#L99-L158) `decide` |
| Report to the vault through the forwarder | [`src/index.ts#L199-L217`](src/index.ts#L199-L217) `deliver` |
| Reads from inside the enclave | [`src/chain.ts#L95-L189`](src/chain.ts#L95-L189) `readChainState` |
| Mandate struct and hash | [`src/mandate.ts`](src/mandate.ts) |
| The vault's range rule, mirrored | [`src/decision.ts`](src/decision.ts) `vaultRejects` |
| Uniswap arithmetic, cross-checked against the SDK | [`src/math.ts`](src/math.ts) |
| Swap and mint sizing | [`src/sizing.ts#L73-L156`](src/sizing.ts#L73-L156) `sizeRecentre` |

## Status

| | |
|---|---|
| Registers a TEE handler with `handlerInTee` | ✅ |
| Decision logic is Helico's | ✅ mandate hash check, in-enclave reads, re-centre rule aligned with the vault, swap and mint sizing, fee ceiling |
| Delivers the verdict to the vault | code and tests only; **no forwarder on Robinhood mainnet**, so on the target chain this leg is replaced by the enclave signing the params (#41) |
| Unit tests, `bun test` | ✅ 100: mandate hash and report tuple pinned to `cast`-produced vectors (commands in the tests), decision table, grid, and boundaries, arithmetic against `@uniswap/v3-sdk` including the swap step, fake `TeeRuntime` answering `eth_call` by selector, failing on RPC faults, and recording `writeReport` |
| Compiles to WASM and simulates in the CRE simulator | the decision alone did (#33, #36, older binary); **this binary has not been simulated**, it needs a deployed vault to read |
| Deployed | ❌ deploy access exists on the team's CRE org; the Confidential Workflows private beta is requested (#41) |

## Use

```ts
import { Runner } from '@chainlink/cre-sdk'
import { configSchema, initWorkflow } from '@helico/plugin-cre'

const runner = await Runner.newRunner({ configSchema })
await runner.run(initWorkflow)
```

Config: `{ schedule, rpcUrl, chainSelectorName, vault, positionManager, stateView, owner, poolId,
mandateHash, gasLimit, slippageBps, maxPoolFeePips, deadlineSeconds }`. Hex values are lowercased on parse. `secrets.yaml` must map
`MANDATE_RANGE_WIDTH_TICKS`, `MANDATE_MIN_IMPROVEMENT_BPS`, `MANDATE_COOLDOWN_SECONDS`,
`MANDATE_MAX_LIQUIDITY`, `MANDATE_EXPIRY`, `MANDATE_MIN_RETAINED_BPS` to env vars, with the same
values the user passed to `setMandate`. Any chain with a v4 `StateView` and a CRE forwarder works; on Robinhood that is
the testnet (`robinhood-testnet`).

## Cross-check the sizing against the vault

`size.ts` prints what the enclave would size for an explicit chain state, as JSON or, with
`--abi`, as the ABI-encoded `RecenterParams` a Foundry fork test can take through `vm.ffi`:

```bash
bun run --filter @helico/plugin-cre size -- --sqrt-price=53939763502276186533003357195988 \
  --tick=130472 --pool-liquidity=56068990832105925359211 --fee=10000 --spacing=10 \
  --liquidity=15826862144268253831 --lower=130200 --upper=130400 --width=20 --slippage=50
```

That state is the ETH/par 1% pool on Robinhood Chain at block 55182962 and a position of
`L = 15826862144268253831` at `[130200, 130400)`, entirely below the price. The enclave
proposes `[130460, 130480)`, sells `40997342171976214693` par for at least `87127370604119`
wei, and mints `L = 155568528444722780435` (a 20-tick range holds ten times the liquidity of
a 200-tick one for the same value). Rebuild the state on a fork and the vault should deliver
that mint or more.

## Check

```bash
bun run --filter @helico/plugin-cre typecheck
bun run --filter @helico/plugin-cre test
```

## Do not forget

- The binary is not confidential, only the data it computes over. Never put the tick or the
  RPC response through `usingTheDons()`; the verdict is the whole report.
- `vaultRejects` and the `RecenterParams` tuple in `abi.ts` must change whenever the vault does; the tuple is
  pinned to a `cast abi-encode` vector in `index.test.ts`, so a drift fails there first. `rangeWidthTicks` is a
  width in ticks and `minImprovementBps` is a relative shrink of the gap to the range's
  centre; the contract defines both.
- The WASM runtime is QuickJS: no `URL` (so no `z.string().url()`), and a negative `int24`
  must be passed to viem as a `bigint`.
- `runtime.log()` inside the handler is for the simulator. Remove it before deploying.
