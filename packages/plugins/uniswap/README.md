# @helico/plugin-uniswap

Uniswap v4 on-chain through the official SDKs and viem. No API key, no wallet: the package
reads pool state, quotes, and builds Universal Router calldata. It never signs or sends.

Exports from [`src/index.ts`](src/index.ts): `addresses`, `poolId`, `getPoolState`,
`quoteExactInputSingle`, `encodeSwapExactInSingle`.
Plan: [`docs/plans/2026-09-05-plugin-uniswap.md`](../../../docs/plans/2026-09-05-plugin-uniswap.md).

## Status

| | |
|---|---|
| Addresses per chain, from `@uniswap/sdk-core` | ✅ Base pinned to the official deployments page in the tests |
| Pool state via `StateView`, quote via v4 `Quoter` | ✅ live on Base, see `smoke` |
| Universal Router swap calldata via `V4Planner` | ✅ accepted by the router in an `eth_call` on Base |
| Sending a swap, approvals, Permit2, liquidity, hooks | ❌ out of scope |
| Trading API (Uniswap's recommended backend path) | ❌ needs an API key the team does not have |
| Wired into an app under `apps/` | ❌ |

## Use

```ts
import { createPublicClient, http, zeroAddress } from 'viem'
import { base } from 'viem/chains'
import { encodeSwapExactInSingle, quoteExactInputSingle } from '@helico/plugin-uniswap'

const client = createPublicClient({ chain: base, transport: http() })
const poolKey = { currency0: zeroAddress, currency1: '0x8335…2913', fee: 500, tickSpacing: 10, hooks: zeroAddress }

const { amountOut } = await quoteExactInputSingle(client, { poolKey, zeroForOne: true, amountIn: 10n ** 18n })
const tx = encodeSwapExactInSingle({ chainId: base.id, poolKey, zeroForOne: true, amountIn: 10n ** 18n, amountOutMinimum: (amountOut * 995n) / 1000n, deadline })
// tx = { to, data, value }: sign and send it yourself, or simulate it with client.call
```

## Check

```bash
bun run --filter @helico/plugin-uniswap typecheck
bun run --filter @helico/plugin-uniswap test    # offline
bun run --filter @helico/plugin-uniswap smoke   # live, read-only, Base public RPC
```

## Do not forget

- `amountOutMinimum` is the only slippage guard. Derive it from a fresh quote.
- An ERC-20 input needs token → Permit2 → Universal Router approvals first. Native ETH does not.
- The V4_SWAP input is `V4Planner.finalize()`. `RoutePlanner.inputs` looks right and reverts.
