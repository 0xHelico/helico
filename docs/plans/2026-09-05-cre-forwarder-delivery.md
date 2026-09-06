# CRE: deliver the verdict to the vault through the forwarder

Issue: #37 (workflow side). The contract side, `onReport` on `HelicoVault`, is a separate piece
of work by the collaborator.

## Problem

The enclave computes a verdict and it goes nowhere. Nothing on-chain consumes it, so the
confidential workflow is adjacent to the product rather than part of it. The vault's
`recenter` takes `RecenterParams` (`owner`, two ticks, `liquidityToMint`, four amount bounds,
`deadline`); the report today carries only the ticks and the mandate hash.

## Constraints, verified

- A `handlerInTee` workflow cannot be deployed without the Confidential Workflows private
  beta, and the CRE account here has no deploy access. The on-chain run is therefore
  `cre workflow simulate --broadcast`: the CLI signs with `CRE_ETH_PRIVATE_KEY` and delivers
  through the `MockKeystoneForwarder`, which performs no DON signature check and passes no
  metadata. On Robinhood Chain Testnet: mock `0x0b93082D9b3C7C97fAcd250082899BAcf3af3885`,
  production `0x8E6E6A1f2B2D4dF503bfd67951CF28F27BF3AF19`. Robinhood mainnet has neither.
- The workflow's `EVMClient.writeReport(runtime, { receiver, report, gasConfig })` takes the
  `ReportResponse` from `runtime.report(...)` as is; the receiver decodes the bytes it was
  given as `encodedPayload`.
- The e2e position (#2544) was burned; the demo needs a freshly minted one.

## Approach

Report shape, proposed on #37: `abi.encode(bool act, bytes32 mandateHash, RecenterParams p)`.
The vault decodes its own struct; nothing is derived on-chain.

The enclave, per run:

1. Reads from the chain, through `eth_call` inside the enclave: `vault.positionOf(owner)`,
   `vault.lastActionAt(owner)`, `positionManager.getPositionLiquidity(tokenId)`,
   `positionManager.getPoolAndPositionInfo(tokenId)` (ticks unpacked as the vault does),
   `stateView.getSlot0(poolId)`. The vault is the source of truth for the cooldown and the
   current range; `config.position` goes away.
2. Recomputes the mandate hash from the secrets and refuses on mismatch, as before.
3. `decideRecentre` as before.
4. On `act`, sizes the mint: amounts the burn will return from `L` at the current
   `sqrtPriceX96` over the old range (v3 `SqrtPriceMath`, rounding down), the liquidity those
   amounts buy over the new range (`maxLiquidityForAmounts`), scaled down by
   `config.slippageBps`; `amount0Min`/`amount1Min` = withdrawn amounts scaled down by the same;
   `amount0Max`/`amount1Max` = the withdrawn amounts, since the mint is funded only by the burn;
   `deadline = now + config.deadlineSeconds`. Native `BigInt`, no JSBI in the WASM bundle;
   cross-checked against `@uniswap/v3-sdk` (dev dependency) over a grid in tests.
5. `runtime.report(...)` with the encoded tuple, then `EVMClient.writeReport` to
   `config.vault` on `config.chainSelectorName`. A hold is not written.

Config becomes `{ schedule, rpcUrl, chainSelectorName, vault, positionManager, stateView,
owner, poolId, mandateHash, gasLimit, slippageBps, deadlineSeconds }`; the tick spacing comes
from the position's pool key.

## How to verify

1. `bun run --filter @helico/plugin-cre typecheck` and `test`: the math grid against the
   Uniswap SDK, the read path against a fake JSON-RPC answering by selector, and the fake
   `TeeRuntime` asserting the report tuple and the `writeReport` call.
2. `cre workflow simulate` (dry run) against Robinhood Chain Testnet with a live position:
   the log shows the tuple and a zero transaction hash.
3. Once the vault with `onReport` is deployed there: `--broadcast`, a real hash, and the
   `Recentred` event on the explorer. Recorded for #21.

## Prompts

The user's instruction was "cek lagi" (check again) after "lanjutin aja sesuai kemauan
temenku ya" (keep going according to what my friend wants). The collaborator's request is
issue #37. The report shape is my proposal on that issue; the rest follows the CRE docs on
on-chain writes and the forwarder directory.

## Revisions — same day, after review and #42

- **Zero mint defect.** With `minRetainedBps = 0` the floor check is `0 < 0` and a zero-liquidity
  mint went through to `act = true`. Fixed with an unconditional hold on `liquidityToMint === 0`,
  regardless of the floor; the vault adds the same `NothingToMint` on its side.
- **The swap is in the report.** #42 chose option 1: the vault swaps inside its own unlock.
  `RecenterParams` gains `zeroForOne`, `amountIn`, `minAmountOut` after `amount1Max` and before
  `deadline`. `sizeRecentre` estimates the swap at the pool's active liquidity with the pool's
  LP fee (`getNextSqrtPriceFromInput`, cross-checked against the SDK), bounds the input so the
  price stays inside the new range (where the vault's `sqrtPriceLimitX96` would stop it), and
  finds the input where the two sides fund the same liquidity by binary search.
- **Fee ceiling.** `maxPoolFeePips` is enclave policy: launch pools on Robinhood carry 6 to 20%
  LP fees, and a re-centre through one costs more than it recovers.
- **Chain.** The user chose Robinhood mainnet only; `writeReport` has no forwarder there, so the
  delivery leg is the one #41 replaces with signing. Everything else in this plan stands.
- **Config hex values are lowercased** on parse so a checksummed value compares equal to keccak
  output; the report tuple is pinned to a `cast abi-encode` vector; RPC faults throw.

## Revision — 2026-09-06, the chain moved to Arbitrum One (#58)

The project moved from Robinhood Chain to Arbitrum One because Arbitrum has both Uniswap v4 (all
addresses from the SDK) and a CRE `KeystoneForwarder`, at a twentieth of the gas. For this plan
that means the forwarder path is back on the critical path: `chainSelectorName:
'ethereum-mainnet-arbitrum-1'`, production forwarder `0xF8344CFd5c43616a4366C34E3EEE75af79a74482`,
and `cre workflow simulate --broadcast` through the `MockKeystoneForwarder`
`0xd770499057619c9a76205fd4168161cf94abc532`. The signature path stays as the chain-independent
design and the reason `AGENT_ROLE` can be a key that exists only inside an enclave. Nothing in
the package changed for the move; this revision records the config and the dependency on the
vault's `onReport` (#37). Tracked in #61.
