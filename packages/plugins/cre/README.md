# @helico/plugin-cre

Chainlink CRE handler that decides, inside a TEE enclave, whether a Uniswap v4 LP position
should be re-centred, and lets only the verdict out. The mandate itself is public on-chain
(`HelicoVault.setMandate` takes it in calldata), so what the enclave keeps confidential is the
decision process: which pool it watches, when it reads, the RPC traffic, and the inputs it
computes over. The mandate hash in the report proves consistency, not secrecy: the enclave
decided against the mandate the vault holds right now, not a stale one.
Plans: [`2026-09-05-cre-mandate-decision.md`](../../../docs/plans/2026-09-05-cre-mandate-decision.md),
[`2026-09-05-cre-vault-alignment.md`](../../../docs/plans/2026-09-05-cre-vault-alignment.md).

Every run (cron trigger, `handlerInTee`):

1. `getSecrets` releases the mandate's thresholds from the Vault DON into the enclave.
2. The enclave recomputes `keccak256(abi.encode(Mandate))` and refuses to act if it differs
   from `config.mandateHash`.
3. It reads the pool's tick through an `eth_call` to `StateView.getSlot0`, made from inside
   the enclave over the HTTP capability.
4. `decideRecentre` (pure): hold on expiry, cooldown, or while still in range; otherwise a
   range of exactly `rangeWidthTicks` centred on the tick, emitted only if `vaultRejects`,
   a line-for-line mirror of `HelicoVault._checkRange`, would accept it.
5. `report(...)` crosses back with `(bool act, int24 tickLower, int24 tickUpper, bytes32 mandateHash)`
   and nothing else.

## Where to look

| | |
|---|---|
| TEE registration, `handlerInTee` | [`src/index.ts#L138-L146`](src/index.ts#L138-L146) |
| The enclave callback, steps 1 to 5 | [`src/index.ts#L98-L135`](src/index.ts#L98-L135) |
| Tick read from inside the enclave | [`src/index.ts#L44-L77`](src/index.ts#L44-L77) |
| What crosses out | [`src/index.ts#L89-L95`](src/index.ts#L89-L95) |
| Mandate struct and hash | [`src/mandate.ts`](src/mandate.ts) |
| The vault's range rule, mirrored | [`src/decision.ts#L55-L73`](src/decision.ts#L55-L73) `vaultRejects` |
| Policy on top of it | [`src/decision.ts#L90-L107`](src/decision.ts#L90-L107) `decideRecentre` |

## Status

| | |
|---|---|
| Registers a TEE handler with `handlerInTee` | ✅ |
| Decision logic is Helico's | ✅ mandate hash check, in-enclave tick read, re-centre rule aligned with the vault |
| Unit tests, `bun test` | ✅ 32: hash vector cross-checked with `cast`, decision table, a grid proving every emitted verdict passes the vault's rule, fake `TeeRuntime` asserting only the verdict crosses out |
| Compiles to WASM and simulates in the CRE simulator | ✅ against the Robinhood Chain Testnet ETH/WETH pool, see below |
| Wired into an app under `apps/` | ❌ #21 |
| Vault contract that consumes the report | ❌ the vault exists (#34) but the workflow is not its agent yet |
| Deployed | ❌ needs CRE deploy access **and** the Confidential Workflows private beta |

## Simulation evidence

`cre workflow simulate` (CLI v1.32.0, SDK 1.19.1) from a throwaway project importing this
package, binary `21e16ffc…a14c31`, pool `0xea84630b…7fd9c5` on Robinhood Chain Testnet at tick
−65, secrets `1000 / 50 / 3600 / 1e18 / 1800000000`, mandate hash
`0x71df72a8…c527e5`:

| Config | Result |
|---|---|
| position 100..1100, correct hash | `RECENTER -560..440` |
| position −1000..0, correct hash | `HOLD (in range)` |
| position 100..1100, hash `0xabab…` | `HOLD (mandate hash mismatch)`, no RPC call made |

## Use

```ts
import { Runner } from '@chainlink/cre-sdk'
import { configSchema, initWorkflow } from '@helico/plugin-cre'

const runner = await Runner.newRunner({ configSchema })
await runner.run(initWorkflow)
```

Config: `{ schedule, rpcUrl, stateView, poolId, tickSpacing, position: { tickLower, tickUpper, lastActionAt }, mandateHash }`.
`secrets.yaml` must map `MANDATE_RANGE_WIDTH_TICKS`, `MANDATE_MIN_IMPROVEMENT_BPS`,
`MANDATE_COOLDOWN_SECONDS`, `MANDATE_MAX_LIQUIDITY`, `MANDATE_EXPIRY` to env vars, with the
same values the user passed to `setMandate`. Any chain
with a v4 `StateView` works; the RPC URL is config.

## Check

```bash
bun run --filter @helico/plugin-cre typecheck
bun run --filter @helico/plugin-cre test
```

## Do not forget

- The binary is not confidential, only the data it computes over. Never put the tick or the
  RPC response through `usingTheDons()`; the verdict is the whole report.
- `vaultRejects` must change whenever `HelicoVault._checkRange` does. `rangeWidthTicks` is a
  width in ticks and `minImprovementBps` is a relative shrink of the gap to the range's
  centre; the contract defines both.
- The WASM runtime is QuickJS: no `URL` (so no `z.string().url()`), and a negative `int24`
  must be passed to viem as a `bigint`.
- `runtime.log()` inside the handler is for the simulator. Remove it before deploying.
