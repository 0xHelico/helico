# @helico/plugin-uniswap

Uniswap v4 on-chain through the official SDKs and viem. No API key, no wallet: the package
reads, quotes, and builds calldata. It never signs or sends. Plans:
[`2026-09-05-plugin-uniswap.md`](../../../docs/plans/2026-09-05-plugin-uniswap.md),
[`2026-09-05-plugin-uniswap-complete.md`](../../../docs/plans/2026-09-05-plugin-uniswap-complete.md).

## Modules

| Module | Exports | Proven by |
|---|---|---|
| [`addresses`](src/addresses.ts) | `addresses(chainId)`, `supportedChainIds()` — v4 contracts, PositionManager, Permit2, from the SDKs | test pins Base to the official deployments page |
| [`pool`](src/pool.ts) | `createPoolKey`, `sortCurrencies`, `poolId`, `getPoolState`, `nearestUsableTick`, `sqrtPriceX96ToPrice`, `tickToPrice`, `priceToTick` | tests; live `StateView` read on Base |
| [`quote`](src/quote.ts) | `quoteExactInputSingle`, `quoteExactOutputSingle`, `quoteExactInput`, `quoteExactOutput` | tests; live v4 `Quoter` calls on Base |
| [`swap`](src/swap.ts) | `encodeSwapExactInSingle`, `encodeSwapExactOutSingle`, `encodeSwapExactIn`, `encodeSwapExactOut`, `buildPath`, `minimumAfterSlippage`, `maximumAfterSlippage`, `deadlineFromNow` | tests decode every action; all four shapes accepted by the Universal Router in a live `eth_call` on Base |
| [`approval`](src/approval.ts) | `getAllowances`, `approvalsNeeded`, `encodeApproveTokenToPermit2`, `encodeApprovePermit2`, `permitSingleTypedData` | tests; live allowance read on Base |
| [`liquidity`](src/liquidity.ts) | `encodeInitializePool`, `encodeMintPosition`, `encodeIncreaseLiquidity`, `encodeDecreaseLiquidity`, `encodeCollectFees`, `sqrtPriceX96FromAmounts` | tests decode the `V4PositionManager` calldata; mint, collect, and burn **executed on Base Sepolia** (see below); `initializePool` and `increase` decoded only |

Not here: sending anything, the Trading API (needs a key), UniswapX, hooks development, CCA.

## Use

```ts
import { createPublicClient, http, zeroAddress } from 'viem'
import { base } from 'viem/chains'
import * as uni from '@helico/plugin-uniswap'

const client = createPublicClient({ chain: base, transport: http() })
const poolKey = uni.createPoolKey({ currencyA: zeroAddress, currencyB: '0x8335…2913', fee: 500, tickSpacing: 10 })

const { amountOut } = await uni.quoteExactInputSingle(client, { poolKey, zeroForOne: true, amountIn: 10n ** 18n })
const tx = uni.encodeSwapExactInSingle({
	chainId: base.id, poolKey, zeroForOne: true, amountIn: 10n ** 18n,
	amountOutMinimum: uni.minimumAfterSlippage(amountOut, 50), deadline: uni.deadlineFromNow(600),
})
// tx = { to, data, value }: simulate with client.call, or sign and send it yourself
```

Multi-hop: `const route = uni.buildPath({ currencies: [ETH, USDC, USDT], pools: [p, p] })`, then
`quoteExactInput` / `encodeSwapExactIn` with `route.exactInPath`, or the exact-output pair with
`route.exactOutPath`. ERC-20 inputs need `getAllowances` → `approvalsNeeded` → the two
approvals (or a signed `permitSingleTypedData`) first.

## Verified on Base Sepolia

`bun run --filter @helico/plugin-uniswap e2e` runs the package for real with a test wallet
(`PRIVATE_KEY` from a gitignored `.env`, never committed). Run of 2026-09-05, wallet
[`0x7461…88C0`](https://sepolia.basescan.org/address/0x746182D0Cccc5CeFc69853bb0325C850029388C0),
pool ETH/USDC 0.05 %:

| Step | Transaction |
|---|---|
| Permit2 → Universal Router approval | [`0x5153…4a68`](https://sepolia.basescan.org/tx/0x51534c221937bd8735168e3c815b1eabeb3e463acdc32e8726811465b1294a68) |
| Mint position NFT #27362 | [`0xd82d…3d96c`](https://sepolia.basescan.org/tx/0xd82d842343b97b1a8e78e99d0e5dd7cc34669e3b5d3e17d89917a5fefea3d96c) |
| Swap exact-in, 0.0005 ETH → USDC | [`0xdf5f…3acc`](https://sepolia.basescan.org/tx/0xdf5f11a37c01002159970f31eba22e8c316e7e9607278ac76c80765550283acc) |
| Swap exact-out, ETH → exactly 0.5 USDC, refund swept | [`0x413f…62ae`](https://sepolia.basescan.org/tx/0x413f5afb1605460a214afa5a0118b2a3bd93fbc052146064d0daac12d33962ae) |
| Swap exact-in, 0.5 USDC → ETH via the Permit2 allowance | [`0xe5d2…06ff`](https://sepolia.basescan.org/tx/0xe5d2d1229a760cf85222954fc7c7311dd4856c8b3c62871264a97204933e06ff) |
| Collect fees | [`0x346d…214a`](https://sepolia.basescan.org/tx/0x346d07bd94d0e4ed1aa478539cc5c551d767fc97765648ebcf671606b8bf214a) |
| Decrease 100 % and burn the NFT | [`0x705b…49d4`](https://sepolia.basescan.org/tx/0x705baa0e221c9083df63eca389ed7d329c54e3e40f313fd28ce6c009f7dc49d4) |

The script retries each step with a fresh build and gives gas estimates a 50 % cushion:
public testnet RPCs sit behind lagging nodes, and one collect ran out of gas at the node's
estimate. Multi-hop is proven by `eth_call` on Base mainnet (`smoke`), not sent here.

## Check

```bash
bun run --filter @helico/plugin-uniswap typecheck
bun run --filter @helico/plugin-uniswap test    # offline, one file per module
bun run --filter @helico/plugin-uniswap smoke   # live, read-only, Base; RPC_URL overrides the endpoint
bun run --filter @helico/plugin-uniswap e2e     # sends real transactions on Base Sepolia; needs PRIVATE_KEY
```

## Do not forget

- `amountOutMinimum` / `amountInMaximum` are the only slippage guards. Derive them from a fresh quote.
- The V4_SWAP input is `V4Planner.finalize()`; `RoutePlanner.inputs` is wrong for it.
- Native-input exact-output swaps leave ETH in the router; the encoders add a router-level
  `SWEEP` back to the caller. The v4 action set has no sweep and the router rejects one.
- A route that ends in its own input currency nets its deltas out and reverts; use distinct endpoints.
