# Uniswap plugin — reusable on-chain v4 package

Issue: [#7](https://github.com/0xHelico/helico/issues/7)

## Problem

Helico wants a Uniswap integration as a reusable package under `packages/plugins/`, the same
shape as the CRE plugin. The Uniswap Foundation bounty audits the code for a genuine
protocol integration, wants a README that points at the exact lines, and requires a
`FEEDBACK.md` plus the developer feedback form. The product logic is still undecided, so the
package must be small, genuinely verifiable without secrets, and honest about what it does
not do.

## Approach

Talk to Uniswap v4 **directly on-chain** through the official SDKs and viem. No API key.

| Piece | How | Verifiable by |
|---|---|---|
| Contract addresses per chain | `CHAIN_TO_ADDRESSES_MAP` from `@uniswap/sdk-core` and `UNIVERSAL_ROUTER_ADDRESS` from `@uniswap/universal-router-sdk` | unit test pins Base to the addresses on the official deployments page |
| Pool id | `keccak256(abi.encode(PoolKey))`, the same derivation as `PoolIdLibrary.toId` in v4-core | unit test compares with `Pool.getPoolId` from `@uniswap/v4-sdk` |
| Pool state | `StateView.getSlot0` and `getLiquidity` via viem `readContract` | live read on Base |
| Quote | `V4Quoter.quoteExactInputSingle` via viem `simulateContract` (a read-only `eth_call`) | live read on Base |
| Swap calldata | `V4Planner` + `RoutePlanner` from the SDKs, then `encodeFunctionData` for Universal Router `execute` | unit test on selector, value, and determinism; live `eth_call` of the calldata on Base from an address that holds ETH, which proves the router accepts it without sending anything |

The package returns `{ to, data, value }` and never signs or sends. Approvals, Permit2,
liquidity, hooks, and the Trading API are out of scope.

### Rejected alternatives

- **Trading API** (Uniswap's recommended path for backends). Needs an API key from the
  developer portal; the team has none, so nothing built on it could be verified. Revisit
  when a key exists.
- **Hand-copied addresses.** The SDK already ships them and they match the docs page.
- **Re-implementing the v4 action encoding with viem only.** Smaller dependency tree and
  WASM-friendlier, but it re-implements what the official SDK does and reviewers would have
  to trust our encoding instead of Uniswap's.
- **`apps/uniswap` alongside the package.** `packages/plugins/<name>` is the reusable
  package only; runnable usage goes under `apps/` in a separate task.

## Scope

**In**

- `packages/plugins/uniswap` as `@helico/plugin-uniswap`: `addresses`, `poolId`,
  `getPoolState`, `quoteExactInputSingle`, `encodeSwapExactInSingle`
- Offline `bun test` suite; a `smoke` script that runs the live checks above against Base
  through viem's default public RPC
- README, root README integration row with line references, `FEEDBACK.md` filled with what
  was actually observed, `AI-USAGE.md` entry

**Out**

- Sending transactions, approvals, Permit2 signatures, liquidity positions, hooks, CCA
- Trading API, UniswapX, cross-chain
- Helico-specific logic and any `apps/` wiring
- Running the package inside a CRE workflow (untested; the SDKs pull in ethers v5)

## How to verify

From the repository root:

| Step | Command | Pass condition |
|---|---|---|
| 1 | `bun install` | clean |
| 2 | `bun run --filter @helico/plugin-uniswap typecheck` | `tsc --noEmit` clean |
| 3 | `bun run --filter @helico/plugin-uniswap test` | every case green, offline |
| 4 | `bun run --filter @helico/plugin-uniswap smoke` | prints live Base pool state, a live quote for 1 ETH → USDC, and `eth_call` of the swap calldata succeeds |
| 5 | `bun run check` | Biome clean |

Step 4 is the gate: real contracts, real pool, real router, no key and no wallet.

## Facts checked during research

- Skills read from `Uniswap/uniswap-ai` @ `936734c` (2026-09-01): `swap-integration`,
  `v4-sdk-integration`, `viem-integration`, `pay-with-any-token`.
- Versions: `@uniswap/sdk-core@7.19.2`, `@uniswap/v4-sdk@2.3.3`,
  `@uniswap/universal-router-sdk@5.11.5`, `viem@2.34.0` (same pin as the CRE plugin).
  All load under bun.
- The docs site redirects non-browser fetches to `llms.mdx` pages; `/docs/uniswap-ai` and
  `/docs/trading-api` return 404 there, the skills page and the deployments page work.
- Base ETH/USDC pool: fee 500, tick spacing 10, no hooks. Live on 2026-09-05: tick
  −198275, liquidity ≈ 5.4e16, quote 1 ETH ≈ 2,447.95 USDC (gas estimate 80,480).
- Sources: https://developers.uniswap.org/docs/uniswap-ai/skills ·
  https://developers.uniswap.org/docs/protocols/v4/deployments ·
  https://github.com/Uniswap/uniswap-ai · https://github.com/Uniswap/v4-periphery
  (`IV4Quoter.sol`, `IStateView.sol`) · https://github.com/Uniswap/v4-core (`PoolId.sol`)

## Prompts

> sekalian buat plugin uniswap ini docsnya https://developers.uniswap.org/docs/uniswap-ai/skills pelajari yg banyak baru eksekusi

*"Also build the Uniswap plugin, here are the docs, study a lot first, then execute."*

Standing instructions from the same session: `packages/plugins/<name>` is a reusable
package only; READMEs stay short; issue, one comment, branch, PR; no direct commits to
`main`; always pull first.
