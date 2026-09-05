# Uniswap plugin — complete, modular, tested

Issue: [#11](https://github.com/0xHelico/helico/issues/11). Extends
[`2026-09-05-plugin-uniswap.md`](2026-09-05-plugin-uniswap.md); same branch and PR (#8).

## Problem

The first cut of `@helico/plugin-uniswap` proved the on-chain path with one file and one
swap shape. The user wants the package to cover Uniswap v4 properly (pools, quotes, swaps
in every shape, approvals, liquidity), split into modules, and tested module by module.

## Approach

Keep the rules of the first plan: official SDKs for encoding, viem for reads and calldata,
no API key, nothing signed or sent. Split by concern, one test file per module:

```
src/
├── index.ts          barrel only
├── types.ts          PoolKey, PathKey, Transaction
├── client.ts         chainIdOf
├── abi/              parseAbi definitions: stateView, quoter, universalRouter, permit2, erc20, positionManager
├── addresses.ts      v4 contracts, PositionManager, Permit2 per chain; supportedChainIds
├── pool.ts           sortCurrencies, createPoolKey, poolId, getPoolState, price and tick helpers
├── quote.ts          exact-input and exact-output, single-hop and multi-hop, through the v4 Quoter
├── swap.ts           Universal Router calldata for the same four shapes, path builder, slippage and deadline helpers
├── approval.ts       allowance reads, approval calldata, Permit2 EIP-712 permit data for signTypedData
├── liquidity.ts      initialize, mint, increase, decrease, collect through V4PositionManager
└── smoke.ts          live, read-only checks on Base
```

Design rules:

- Every function takes plain viem types (`Address`, `Hex`, `bigint`) and returns plain data.
  SDK objects (`Token`, `Pool`, `Position`, JSBI) stay inside `liquidity.ts`.
- Calldata builders return `{ to, data, value }` and never touch a wallet.
- Slippage is expressed in basis points as a `bigint` math helper, not floats.
- Multi-hop paths use the v4-periphery `PathKey` struct in the order the router reads it:
  exact-input lists the hops after `currencyIn`; exact-output lists them before `currencyOut`,
  starting with the input currency. `buildPath` produces both from one currency list so
  callers do not have to remember this.

### Rejected alternatives

- **Trading API** — still no key; unchanged from the first plan.
- **Wrapping the SDK's `Trade`/`Route` objects** — they need `Currency` instances with
  decimals for every hop and pull the whole v3-sdk math in; the router only needs
  addresses. Plain structs keep the public API viem-shaped.
- **Live simulation of liquidity calldata** — needs an account holding both tokens with
  Permit2 allowances set; not possible with a plain `eth_call`. Liquidity calldata is
  produced by the official `V4PositionManager` and checked by decoding, and the README says
  it is not simulated.

## Scope

**In:** the modules above, their tests, the smoke script extended to exact-output
simulation and allowance reads, README rewritten per module, root README row updated.

**Out:** Trading API, UniswapX, hooks development, CCA, sending anything, `apps/` wiring.

## How to verify

| Step | Command | Pass condition |
|---|---|---|
| 1 | `bun run --filter @helico/plugin-uniswap typecheck` | clean |
| 2 | `bun run --filter @helico/plugin-uniswap test` | every module's tests green, offline |
| 3 | `bun run --filter @helico/plugin-uniswap smoke` | live on Base: pool state and price, exact-in and exact-out quotes, exact-in **and** exact-out swap calldata accepted by the router via `eth_call`, allowance read |
| 4 | `bun run check` | Biome clean |

## Facts checked during research

- `@uniswap/v4-sdk@2.3.3` exports `V4Planner`, `V4PositionManager` (`createCallParameters`,
  `addCallParameters`, `removeCallParameters`, `collectCallParameters`), `Pool`, `Position`
  (`fromAmounts`), `Actions`; it does **not** export `encodeMultihopExactInPath` (the
  `v4-sdk-integration` skill snippet is stale).
- `V4Planner` swap structs for Universal Router 2.0: `SWAP_EXACT_IN` is
  `(currencyIn, PathKey[] path, amountIn, amountOutMinimum)`, `SWAP_EXACT_OUT` is
  `(currencyOut, PathKey[] path, amountOut, amountInMaximum)`; single-hop variants take a
  `PoolKey`. `PathKey` is `(intermediateCurrency, fee, tickSpacing, hooks, hookData)`.
- v4 `Quoter` takes the same `PathKey` in `QuoteExactParams(exactCurrency, path, exactAmount)`.
- `@uniswap/permit2-sdk@1.4.0`: `PERMIT2_ADDRESS`, `MaxAllowanceTransferAmount`
  (uint160 max), `MaxAllowanceExpiration` (uint48 max), `AllowanceTransfer.getPermitData`.
  Permit2 `allowance(owner, token, spender)` returns `(uint160 amount, uint48 expiration,
  uint48 nonce)`; `approve(token, spender, uint160 amount, uint48 expiration)`.
- `@uniswap/v3-sdk@3.31.3` provides `nearestUsableTick`, `TickMath`, `encodeSqrtRatioX96`.
- `V4PositionManager.addCallParameters` requires `useNative` to be set exactly when
  `currency0` is native, encodes `initializePool` first when `createPool` is set, and adds
  `SETTLE_PAIR` plus a `SWEEP` for native pools.

## Prompts

> bisakah buat lengkap di plugin uniswap jangan cuma swap doang udah gitu di index.ts semua lagi, buat modular, clean code, professional, refactored, dan tested

*"Can you make the Uniswap plugin complete, not only swap, and not everything in
`index.ts`; make it modular, clean, professional, refactored, and tested."*
