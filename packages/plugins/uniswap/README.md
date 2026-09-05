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
| [`liquidity`](src/liquidity.ts) | `encodeInitializePool`, `encodeMintPosition`, `encodeIncreaseLiquidity`, `encodeDecreaseLiquidity`, `encodeCollectFees`, `sqrtPriceX96FromAmounts` | tests decode the `V4PositionManager` calldata; **not simulated on-chain** (needs an account holding both tokens) |

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

## Check

```bash
bun run --filter @helico/plugin-uniswap typecheck
bun run --filter @helico/plugin-uniswap test    # offline, one file per module
bun run --filter @helico/plugin-uniswap smoke   # live, read-only, Base; RPC_URL overrides the endpoint
```

## Do not forget

- `amountOutMinimum` / `amountInMaximum` are the only slippage guards. Derive them from a fresh quote.
- The V4_SWAP input is `V4Planner.finalize()`; `RoutePlanner.inputs` is wrong for it.
- Native-input exact-output swaps leave ETH in the router; the encoders add a router-level
  `SWEEP` back to the caller. The v4 action set has no sweep and the router rejects one.
- A route that ends in its own input currency nets its deltas out and reverts; use distinct endpoints.
