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
5. Crosses out with the verdict only, one of two ways. `delivery: 'forwarder'` (chains with a CRE
   forwarder; Arbitrum One is the target chain since #58): `EVMClient.writeReport` of
   `abi.encode(bool act, bytes32 mandateHash, RecenterParams p)` to the vault's `onReport`.
   `delivery: 'signature'` (any chain): the agent key, a Vault DON secret released only into the
   enclave, signs an EIP-712 `Recenter(RecenterParams params, bytes32 mandateHash, uint256 nonce)`
   with the vault's nonce, and the authorisation leaves as the DON report and as the handler's
   result for a relayer; the key never leaves. A hold signs and writes nothing.

## On Arbitrum One

| | |
|---|---|
| CRE chain selector | `ethereum-mainnet-arbitrum-1` |
| `KeystoneForwarder` (a deployed workflow writes through it) | `0xF8344CFd5c43616a4366C34E3EEE75af79a74482` |
| `MockKeystoneForwarder` (`cre workflow simulate --broadcast` writes through it; verifies nothing) | `0xd770499057619c9a76205fd4168161cf94abc532` |
| v4 `PoolManager` / `StateView` / `PositionManager`, from the SDK | `0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32` / `0x76Fd297e2D437cd7f76d50F01AfE6160f86e9990` / `0xd88F38F930b7952f2DB2432Cb002E7abbF3dD869` |
| Demo pool, ETH/ARB 0.05%, spacing 10 | `0xb37da7d5beb04539b6c497a15794748fc0ce1da7afc61133e3253eff76229ae5` |

The forwarder path needs the vault to implement `IReceiver.onReport` and to hold `AGENT_ROLE`
for the forwarder it trusts (#37, contract side); the signature path needs
`recenterWithSignature`, which is on `main`. In a simulation the enclave is the simulator and
the forwarder is the mock, so what is demonstrated is the delivery path, not DON authorisation;
the README says so wherever the demo is described.

## Why there is a swap in the report

An out-of-range position holds a single token, and a single token cannot fund a range that
contains the price (numbers on #42). So the report carries `zeroForOne`, `amountIn`, and
`minAmountOut` and the vault swaps through the position's own pool inside its unlock before it
mints. Until that vault lands, a re-centre on a pool with no liquidity to swap against is a
hold (`NothingToMint`).

## Where to look

| | |
|---|---|
| TEE registration, `handlerInTee` | [`src/index.ts#L268-L276`](src/index.ts#L268-L276) |
| The enclave callback, steps 1 to 5 | [`src/index.ts#L173-L234`](src/index.ts#L173-L234) |
| Policy and sizing on the chain state | [`src/index.ts#L111-L170`](src/index.ts#L111-L170) `decide` |
| Report to the vault through the forwarder | [`src/index.ts#L244-L265`](src/index.ts#L244-L265) `deliver` |
| The signed authorisation, EIP-712 | [`src/sign.ts#L65-L75`](src/sign.ts#L65-L75) `signRecentre`, typed data above it |
| Reads from inside the enclave | [`src/chain.ts#L98-L201`](src/chain.ts#L98-L201) `readChainState` |
| Mandate struct and hash | [`src/mandate.ts`](src/mandate.ts) |
| The vault's range rule, mirrored | [`src/decision.ts`](src/decision.ts) `vaultRejects` |
| Uniswap arithmetic, cross-checked against the SDK | [`src/math.ts`](src/math.ts) |
| Swap and mint sizing | [`src/sizing.ts#L73-L156`](src/sizing.ts#L73-L156) `sizeRecentre` |

## Status

| | |
|---|---|
| Registers a TEE handler with `handlerInTee` | ✅ |
| Decision logic is Helico's | ✅ mandate hash check, in-enclave reads, re-centre rule aligned with the vault, swap and mint sizing, fee ceiling |
| Delivers the verdict to the vault | ✅ code and tests for both modes: a DON report through the forwarder (Arbitrum One) or the enclave's signature with the agent key (any chain); **not yet run against a deployed vault** |
| Unit tests, `bun test` | ✅ 110: EIP-712 digest checked against the spec by hand, signature recovery, mandate hash and report tuple pinned to `cast`-produced vectors (commands in the tests), decision table, grid, and boundaries, arithmetic against `@uniswap/v3-sdk` including the swap step, fake `TeeRuntime` answering `eth_call` by selector, failing on RPC faults, and recording `writeReport` |
| Compiles to WASM and simulates in the CRE simulator | the decision alone did (#33, #36, older binary); **this binary has not been simulated**, it needs a deployed vault to read |
| Deployed | ❌ deploy access exists on the team's CRE org; the Confidential Workflows private beta is requested (#41) |

## Use

```ts
import { Runner } from '@chainlink/cre-sdk'
import { configSchema, initWorkflow } from '@helico/plugin-cre'

const runner = await Runner.newRunner({ configSchema })
await runner.run(initWorkflow)
```

Config: `{ schedule, rpcUrl, delivery, vault, positionManager, stateView, owner, poolId,
mandateHash, gasLimit, slippageBps, maxPoolFeePips, deadlineSeconds }` plus, for `delivery:
'signature'`, `chainId` and optionally `domainName` (`HelicoVault`), `domainVersion` (`1`),
`agentKeySecretId` (`AGENT_KEY`), `noncesFunction` (`nonces`); for `delivery: 'forwarder'`,
`chainSelectorName` (`ethereum-mainnet-arbitrum-1` on the target chain). Hex values are lowercased on parse. In signature mode `secrets.yaml` also
maps `AGENT_KEY` to the env var holding the agent's private key. `secrets.yaml` must map
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

- The binary is not confidential, only the data it computes over. Never put the tick, the RPC
  response, or the agent key through `usingTheDons()`; the verdict or the signed authorisation
  is the whole report.
- In the simulator the enclave is the simulator, so the agent key is on the machine that runs
  it. The design makes "no re-centre the enclave did not sign" true once deployed with the
  Confidential Workflows beta; until then say so.
- `vaultRejects` and the `RecenterParams` tuple in `abi.ts` must change whenever the vault does; the tuple is
  pinned to a `cast abi-encode` vector in `index.test.ts`, so a drift fails there first. `rangeWidthTicks` is a
  width in ticks and `minImprovementBps` is a relative shrink of the gap to the range's
  centre; the contract defines both.
- The WASM runtime is QuickJS: no `URL` (so no `z.string().url()`), and a negative `int24`
  must be passed to viem as a `bigint`.
- `runtime.log()` inside the handler is for the simulator. Remove it before deploying.
