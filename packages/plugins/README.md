# Plugins

**Every partner integration lives here**, one package each, as `@helico/plugin-<name>`. Apps
consume them; apps never talk to a protocol directly.

| Plugin | Integration |
|---|---|
| [`cre/`](cre/) | Chainlink CRE confidential workflows |
| [`1inch/`](1inch/) | Aqua mandates, priced by the deployed SwapVM |
| [`thegraph/`](thegraph/) | Our Aqua subgraph, and Uniswap v4's published one |
| [`uniswap/`](uniswap/) | Uniswap v4 on any chain: pools, quotes, swaps, Permit2, liquidity |

## Why not just put it in the app

Because a partner reviewer has to find the lines that prove the integration, and one package per
partner keeps those references stable. It also keeps apps thin: what the product does stays
separable from how it talks to a protocol.

The exception is anything deployed. `HelicoMandateSwap` is an Aqua app, so it is Solidity in
[`contracts/`](../../contracts/), wrapping it in a package would add a layer that proves nothing.
The rule is about where protocol knowledge lives, not about the directory.

## Adding one

1. `packages/plugins/<name>/` with a `package.json` naming it `@helico/plugin-<name>`
2. `typecheck` and `test` scripts, so the workspace tasks and CI pick it up
3. A README saying what it does and which lines prove it
4. A row in the table above
