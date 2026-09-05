# @helico/plugin-cre

Chainlink CRE handler that decides, inside a TEE enclave, whether a Uniswap v4 LP position
should be re-centred, and lets only the verdict out. The thresholds the user signed never
leave the enclave; the vault checks the verdict against the mandate hash it committed to.
Plan: [`docs/plans/2026-09-05-cre-mandate-decision.md`](../../../docs/plans/2026-09-05-cre-mandate-decision.md).

Every run (cron trigger, `handlerInTee`):

1. `getSecrets` releases the private half of the mandate from the Vault DON into the enclave.
2. The enclave recomputes `keccak256(abi.encode(Mandate))` and refuses to act if it differs
   from `config.mandateHash`.
3. It reads the pool's tick through an `eth_call` to `StateView.getSlot0`, made from inside
   the enclave over the HTTP capability, so which pool and when stay confidential.
4. `decideRecentre` (pure): hold on expiry, cooldown, in range, or drift below the user's
   improvement floor; otherwise a new range of `rangeWidthBps` ticks centred on the tick.
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
| Decision rules | [`src/decision.ts`](src/decision.ts) |

## Status

| | |
|---|---|
| Registers a TEE handler with `handlerInTee` | ✅ |
| Decision logic is Helico's | ✅ mandate hash check, confidential tick read, re-centre rule |
| Unit tests, `bun test` | ✅ 26: hash vector cross-checked with `cast`, decision table, fake `TeeRuntime` asserting only the verdict crosses out |
| Compiles to WASM and simulates in the CRE simulator | ✅ against the Robinhood Chain Testnet ETH/WETH pool, see below |
| Wired into an app under `apps/` | ❌ #21 |
| Vault contract that consumes the report | ❌ #30 |
| Deployed | ❌ needs CRE deploy access **and** the Confidential Workflows private beta |

## Simulation evidence

`cre workflow simulate` (CLI v1.32.0, SDK 1.19.1) from a throwaway project importing this
package, binary `ee20a852…81f121`, pool `0xea84630b…7fd9c5` on Robinhood Chain Testnet at tick
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
`secrets.yaml` must map `MANDATE_RANGE_WIDTH_BPS`, `MANDATE_MIN_IMPROVEMENT_BPS`,
`MANDATE_COOLDOWN_SECONDS`, `MANDATE_MAX_NOTIONAL`, `MANDATE_EXPIRY` to env vars. Any chain
with a v4 `StateView` works; the RPC URL is config.

## Check

```bash
bun run --filter @helico/plugin-cre typecheck
bun run --filter @helico/plugin-cre test
```

## Do not forget

- The binary is not confidential, only the data it computes over. Never put the thresholds,
  the tick, or the RPC response through `usingTheDons()`.
- The WASM runtime is QuickJS: no `URL` (so no `z.string().url()`), and a negative `int24`
  must be passed to viem as a `bigint`.
- `runtime.log()` inside the handler is for the simulator. Remove it before deploying.
