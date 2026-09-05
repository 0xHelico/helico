# @helico/plugin-uniswap

Uniswap v4 on-chain through the official SDKs and viem, on any chain. No API key, no wallet:
the package resolves addresses, reads pools, quotes, and builds calldata. It never signs or
sends. Plans: [`2026-09-05-plugin-uniswap.md`](../../../docs/plans/2026-09-05-plugin-uniswap.md),
[`2026-09-05-plugin-uniswap-complete.md`](../../../docs/plans/2026-09-05-plugin-uniswap-complete.md).

## Modules

| Module | Exports | Proven by |
|---|---|---|
| [`addresses`](src/addresses.ts) | `addresses(chainId)` with the Universal Router version per chain, `registerV4Addresses`, `supportedChainIds` | tests pin Base, Base Sepolia, and Robinhood Chain to the official deployments page |
| [`networks`](src/networks.ts) | `network(key)`, `registerNetwork`, `networkByChainId`, built-ins for Ethereum, Arbitrum, Polygon, BNB, Base, Base Sepolia, Robinhood Chain, Robinhood Chain Testnet | tests resolve every built-in |
| [`pool`](src/pool.ts) | `createPoolKey`, `sortCurrencies`, `poolId`, `getPoolState`, `nearestUsableTick`, `sqrtPriceX96ToPrice`, `tickToPrice`, `priceToTick` | tests; live `StateView` reads |
| [`quote`](src/quote.ts) | `quoteExactInputSingle`, `quoteExactOutputSingle`, `quoteExactInput`, `quoteExactOutput` | tests through the real ABI; live v4 `Quoter` calls |
| [`swap`](src/swap.ts) | `encodeSwapExactInSingle`, `encodeSwapExactOutSingle`, `encodeSwapExactIn`, `encodeSwapExactOut`, `buildPath`, `minimumAfterSlippage`, `maximumAfterSlippage`, `deadlineFromNow` | tests decode every action in both router layouts; all four shapes accepted by the router live |
| [`approval`](src/approval.ts) | `getAllowances`, `approvalsNeeded`, `encodeApproveTokenToPermit2`, `encodeApprovePermit2`, `permitSingleTypedData` | tests; approvals executed on-chain |
| [`liquidity`](src/liquidity.ts) | `encodeInitializePool`, `encodeMintPosition`, `encodeIncreaseLiquidity`, `encodeDecreaseLiquidity`, `encodeCollectFees`, `sqrtPriceX96FromAmounts` | tests decode the `V4PositionManager` calldata; all six executed on-chain |

Not here: sending anything, the Trading API (needs a key), UniswapX, hooks development, CCA.
`permitSingleTypedData` produces the EIP-712 data for a Permit2 signature, but this package
does not encode the router's `PERMIT2_PERMIT` command yet; use the on-chain approvals, or
consume the signature in your own router call.

## Chains

`addresses(chainId)` resolves from `@uniswap/sdk-core` and `@uniswap/universal-router-sdk`
first, picking the router version that chain has (2.0 where it exists, else 2.1.1, else
2.2.0; the encoders build the matching swap structs). Chains the SDKs do not list come from
[`deployments.ts`](src/deployments.ts) or from `registerV4Addresses(chainId, …)` at runtime.

`networks.ts` adds what the scripts need per chain: the viem chain, explorer, wrapped native,
the quote stablecoin, and a verified reference pool. `registerNetwork({...})` adds any chain.
Built-ins:

| `CHAIN` | Chain | Router | Reference pool |
|---|---|---|---|
| `ethereum` | Ethereum | 2.0 | not verified yet, run `discover` |
| `arbitrum` | Arbitrum One | 2.0 | not verified yet |
| `polygon` | Polygon | 2.0 | not verified yet |
| `bnb` | BNB Smart Chain | 2.0 | BNB/USDC 0.05 %, read with liquidity |
| `base` | Base | 2.0 | ETH/USDC 0.05 %, read with liquidity; multi-hop via USDT |
| `base-sepolia` | Base Sepolia | 2.0 | ETH/USDC 0.05 % (Circle test USDC) |
| `robinhood` | Robinhood Chain (4663) | 2.1.1 | pending, see below |
| `robinhood-testnet` | Robinhood Chain Testnet (46630) | 2.1.1 | none; the e2e makes its own |

**Robinhood Chain.** viem ships no definition, so [`chains.ts`](src/chains.ts) defines both
networks from Robinhood's docs. The mainnet only has Universal Router 2.1.1. The quote asset
of most pools is USDG (Global Dollar), and most ETH/USDG pools use a dynamic-fee hook. v4 is
also on the testnet at the mainnet addresses (PoolManager, Quoter, and StateView bytecode is
identical), which neither Uniswap's deployments page nor the SDKs list; that deployment is
recorded in `deployments.ts` with the evidence.

## Where to look

The lines that prove the integration, for reviewers:

| Evidence | Lines |
|---|---|
| Universal Router `execute` with V4_SWAP and the router-level SWEEP | [`src/swap.ts#L100-L121`](src/swap.ts#L100-L121) |
| v4 `SWAP_EXACT_IN_SINGLE` action, router-version aware | [`src/swap.ts#L135-L170`](src/swap.ts#L135-L170) |
| v4 `Quoter` through a read-only `eth_call` | [`src/quote.ts#L17-L28`](src/quote.ts#L17-L28) |
| Protocol state through `StateView` | [`src/pool.ts#L64-L82`](src/pool.ts#L64-L82) |
| `PoolId` derivation | [`src/pool.ts#L39-L52`](src/pool.ts#L39-L52) |
| Addresses and router version from the official SDKs | [`src/addresses.ts#L46-L67`](src/addresses.ts#L46-L67) |
| Any chain: runtime registration | [`src/addresses.ts#L87-L89`](src/addresses.ts#L87-L89) |
| Permit2 approvals and EIP-712 permit data | [`src/approval.ts#L93-L110`](src/approval.ts#L93-L110) |
| `V4PositionManager` mint | [`src/liquidity.ts#L93-L124`](src/liquidity.ts#L93-L124) |
| Robinhood Chain definitions | [`src/chains.ts#L8-L14`](src/chains.ts#L8-L14) |

## Use

```ts
import { createPublicClient, http } from 'viem'
import * as uni from '@helico/plugin-uniswap'

const net = uni.network('robinhood')
const client = createPublicClient({ chain: net.chain, transport: http() })
const poolKey = uni.createPoolKey({ currencyA: '0x0000000000000000000000000000000000000000', currencyB: net.usd.address, fee: 500, tickSpacing: 10 })

const { amountOut } = await uni.quoteExactInputSingle(client, { poolKey, zeroForOne: true, amountIn: 10n ** 18n })
const tx = uni.encodeSwapExactInSingle({
	chainId: net.chain.id, poolKey, zeroForOne: true, amountIn: 10n ** 18n,
	amountOutMinimum: uni.minimumAfterSlippage(amountOut, 50), deadline: uni.deadlineFromNow(600),
})
// tx = { to, data, value }: simulate with client.call, or sign and send it yourself
```

Multi-hop: `uni.buildPath({ currencies: [A, B, C], pools: [p, p] })`, then `quoteExactInput` /
`encodeSwapExactIn` with `exactInPath`, or the exact-output pair with `exactOutPath`. ERC-20
inputs need `getAllowances` → `approvalsNeeded` → the two approvals first.

## Scripts

```bash
bun run --filter @helico/plugin-uniswap typecheck
bun run --filter @helico/plugin-uniswap test                  # offline, one file per module
CHAIN=base bun run --filter @helico/plugin-uniswap smoke      # live, read-only: state, quotes, every swap shape via eth_call
CHAIN=robinhood bun run --filter @helico/plugin-uniswap discover   # find native/usd pools with liquidity
CHAIN=base-sepolia bun run --filter @helico/plugin-uniswap e2e     # sends real transactions; needs PRIVATE_KEY
```

Copy `.env.example` to `.env` for `e2e`; bun loads it. `RPC_URL` overrides a public endpoint.

## Executed on-chain

`e2e` needs nothing but the native coin: it wraps some, initialises a native/wrapped pool of
its own at 1:1 when none exists, then mints, increases, swaps every single-hop shape, collects,
and burns. Every step sends with a 50 % gas cushion and never resends once a hash exists.

Base Sepolia, 2026-09-05, wallet
[`0x7461…88C0`](https://sepolia.basescan.org/address/0x746182D0Cccc5CeFc69853bb0325C850029388C0),
all `status: success`:

| Step | Transaction |
|---|---|
| Wrap 0.001 ETH | [`0xc0b4…ca48c`](https://sepolia.basescan.org/tx/0xc0b4ad36989666a0801840966c1d0e311b7747ab35a272d3dd4eed40ac0ca48c) |
| Initialize the ETH/WETH pool at 1:1 | [`0xdbe0…a271b`](https://sepolia.basescan.org/tx/0xdbe0b6e220aed674954254251dc97aa4f6a5f5461c0410d693063b3338ba271b) |
| Approve WETH → Permit2 | [`0x1215…304af`](https://sepolia.basescan.org/tx/0x1215a026f740ef57e2693f8f0dfde4e23c6ae1efd2c9fd185825ac5847a304af) |
| Approve Permit2 → PositionManager | [`0x948a…d2850`](https://sepolia.basescan.org/tx/0x948a2f998ac6afe9aed8c582346f6cc58dac37ec109a71db1aaa6a31349d2850) |
| Mint position NFT #27363 | [`0x7040…3f2ce`](https://sepolia.basescan.org/tx/0x7040d571e405266d6c89246a732fd112af377ec446ba14db65cdf51b8323f2ce) |
| Increase liquidity | [`0x6a57…70413`](https://sepolia.basescan.org/tx/0x6a571a486f256e5661c7a5322175e45de6b00b34eb30ba61ce575c2f78870413) |
| Swap exact-in, 0.00004 ETH → WETH | [`0xb728…e0f89`](https://sepolia.basescan.org/tx/0xb7285a3cc01fdfd0e2510f77b8844ad5743fea04413944d76e57d9f01f6e0f89) |
| Swap exact-out, ETH → exactly 0.00004 WETH, refund swept | [`0x8f1d…ceab7`](https://sepolia.basescan.org/tx/0x8f1dc762c6d4044bbf8e11abd5ee0df9e12e68f2323c47f0e0851a39121ceab7) |
| Approve Permit2 → Universal Router | [`0x693d…7922b`](https://sepolia.basescan.org/tx/0x693dcd298c86ad5bf7e10a646edb2e75a56cfbfce9a187dab0250ad085a7922b) |
| Swap exact-in, 0.00004 WETH → ETH via the Permit2 allowance | [`0x3cb2…f9235`](https://sepolia.basescan.org/tx/0x3cb223ccb8c287891e588104038bd4acf79883ac7a1928135b8084c536df9235) |
| Collect fees | [`0xfbbc…e3ed5`](https://sepolia.basescan.org/tx/0xfbbc73fe97ab91f532ec9e46b465352ea6589c3d1e51a630eb56cc6e162e3ed5) |
| Decrease 100 % and burn the NFT | [`0xf98a…ad617`](https://sepolia.basescan.org/tx/0xf98a4ad77e81b07d7f15efcafa8f169e5d77b84d5bbb1bbe06568992223ad617) |

An earlier run against the public ETH/USDC pool (mint #27362, swaps, collect, burn) is in the
commit history of this file. Robinhood Chain runs are pending: the smoke needs a verified
reference pool, the e2e needs testnet faucet ETH.

## Do not forget

- `amountOutMinimum` / `amountInMaximum` are the only slippage guards. Derive them from a fresh quote.
- The V4_SWAP input is `V4Planner.finalize()`; `RoutePlanner.inputs` is wrong for it.
- Native-input exact-output swaps leave ETH in the router; the encoders add a router-level
  `SWEEP` back to the caller. The v4 action set has no sweep and the router rejects one.
- A route that ends in its own input currency nets its deltas out and reverts; use distinct endpoints.
- Public RPCs lag across nodes and under-estimate gas for position-manager calls; the e2e
  retries with fresh builds and cushions gas.
