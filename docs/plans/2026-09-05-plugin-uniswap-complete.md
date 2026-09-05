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

## Revision — what the live checks changed

- `Actions.SWEEP` inside the v4 action list is rejected by the router
  (`UnsupportedAction(0x14)`). The native refund for exact-output swaps is a router-level
  `SWEEP` command after `V4_SWAP` (`commands = 0x1004`, two inputs).
- The first multi-hop smoke used ETH → USDC → ETH through one pool. The Quoter accepts it,
  the router reverts with `V4TooLittleReceived(min, 0)`: same-currency endpoints net their
  deltas out. The smoke now uses ETH → USDC → USDT, both at the 0.05 % tier.
- `mainnet.base.org` rate-limits the smoke (HTTP 429); it defaults to
  `base-rpc.publicnode.com` and honours `RPC_URL`.
- `addresses()` returns checksummed addresses so decoded calldata compares equal.

## Revision — executed on Base Sepolia

Issue [#12](https://github.com/0xHelico/helico/issues/12). The user provided a test wallet
(the key lives in a gitignored `.env`, loaded by bun as `PRIVATE_KEY`). `src/e2e.ts` runs the
package for real on Base Sepolia, where the SDKs know every v4 contract and an ETH/USDC
0.05 % pool exists: Permit2 approvals, mint, exact-in and exact-out swaps with native input,
an ERC-20-input swap through the Permit2 allowance, collect, decrease and burn. Every
transaction hash is in the package README.

What the runs taught:

- Public testnet RPCs are load-balanced across nodes that lag by a block or two. A freshly
  mined approval was invisible to the node estimating the next call (`AllowanceExpired(0)`),
  a quote came from a node that had not seen the mint, and balances read right after a
  receipt were stale. The script now rebuilds each transaction per attempt, retries, and pins
  balance reads to receipt block numbers.
- A collect ran out of gas at the node's estimate (110k limit, 162k needed). Sends now carry
  a 50 % cushion over `estimateGas`.
- The liquidity row of the status table moves from "decoded only" to "executed", except
  `initializePool` and `increase`, which are still decoded only.

## Revision — any viem client, everything type-checked

Issue [#13](https://github.com/0xHelico/helico/issues/13). The editor showed that a
`createPublicClient({ chain: baseSepolia })` client did not fit the `PublicClient` parameter:
chains with OP-stack formatters give the client chain-specific return types. `tsc` had not
caught it because scripts and tests were excluded. Now the reads take
`Client<Transport, Chain | undefined>` and call viem's actions, the package tsconfig uses
`types: ["bun"]` with no excludes, and the tests fake the client at the `request` level so they
exercise the real ABI encoding. Also: 3-digit numeric separators and `.at(-1)`, both flagged
by the editor's linter.

## Revision — any chain, Robinhood Chain first

Issue [#14](https://github.com/0xHelico/helico/issues/14), plus the review on #8. The user
asked for Robinhood Chain mainnet and testnet, then for a shape that scales to any chain.

- **Resolver:** `addresses(chainId)` reads the SDKs first, picks the Universal Router version
  per chain (2.0 where it exists, else 2.1.1, else 2.2.0) and exposes it. Chains the SDKs do
  not list resolve from `deployments.ts` or from `registerV4Addresses()` at runtime, so any
  chain works without editing the package.
- **Encoders follow the router:** routers from 2.1.1 on read swap structs with a
  `minHopPriceX36` field; the encoders build the layout the resolved version expects and the
  tests parse both layouts with the SDK's own parser.
- **Network registry:** `networks.ts` carries chain definitions (viem has none for Robinhood
  Chain; `chains.ts` defines mainnet 4663 and testnet 46630 from Robinhood's docs), wrapped
  native, the quote stablecoin, and reference pools. `registerNetwork()` adds a chain.
- **Scripts:** `CHAIN=<key>` picks the network. The e2e no longer needs a stablecoin: it wraps
  native into the chain's WETH, initialises a native/wrapped pool of its own when none exists,
  and runs every builder against it, which also executes `initializePool` and
  `increaseLiquidity`. First run on Base Sepolia: 12 transactions, all successful.
- **Robinhood facts checked on 2026-09-05:** mainnet RPC `https://rpc.mainnet.chain.robinhood.com`,
  explorer `https://robinhoodchain.blockscout.com`; testnet RPC
  `https://rpc.testnet.chain.robinhood.com/rpc`, faucet `https://faucet.testnet.chain.robinhood.com`.
  All six v4 contracts have code on both networks; PoolManager, Quoter, and StateView bytecode
  is identical across them. The quote asset of most mainnet pools is USDG (Global Dollar,
  `0x5fc5…d168`, 6 decimals), not USDC, and most ETH/USDG pools use a dynamic-fee hook.
- **Review items from #8:** the e2e never rebuilds once a hash exists (only the receipt is
  polled); Permit2 approvals default to 30 days; Base Sepolia is pinned in the tests;
  `permitSingleTypedData` is documented as not consumed by this package's own commands.
- **Robinhood mainnet smoke, 2026-09-05:** the deepest hook-less ETH/USDG pool is fee 87 /
  spacing 1 (liquidity 2.2e17); quotes and both single-hop swap shapes in the 2.1.1 layout
  were accepted by the router via `eth_call`. The e2e waits for testnet faucet ETH.
