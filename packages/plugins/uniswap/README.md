# @helico/plugin-uniswap

Uniswap v4 on any chain, through the official SDKs and viem. No API key, no wallet: it resolves
addresses, reads pools, quotes, and builds calldata. **It never signs or sends.**

Plans: [`plugin-uniswap`](../../../docs/plans/2026-09-05-plugin-uniswap.md),
[`plugin-uniswap-complete`](../../../docs/plans/2026-09-05-plugin-uniswap-complete.md).

## Modules

| Module | What it gives you |
|---|---|
| [`addresses`](src/addresses.ts) | `addresses(chainId)` with the right Universal Router version per chain, plus runtime registration for chains the SDKs do not list |
| [`networks`](src/networks.ts) | the viem chain, explorer, wrapped native, quote stablecoin and a verified reference pool, per chain |
| [`pool`](src/pool.ts) | pool keys, `poolId`, `getPoolState` through `StateView`, tick and price conversions |
| [`quote`](src/quote.ts) | the v4 `Quoter`, exact-in and exact-out, single and multi-hop |
| [`swap`](src/swap.ts) | calldata for all four swap shapes, in whichever router layout the chain has |
| [`approval`](src/approval.ts) | Permit2 allowances, approval calldata, and EIP-712 permit data |
| [`liquidity`](src/liquidity.ts) | initialise, mint, increase, decrease, collect, burn |

Not here: sending anything, the Trading API, UniswapX, hooks, CCA.

## Where to look

The lines that prove the integration:

| Evidence | Lines |
|---|---|
| Universal Router `execute` with `V4_SWAP` and the router-level `SWEEP` | [`swap.ts#L100-L121`](src/swap.ts#L100-L121) |
| `SWAP_EXACT_IN_SINGLE`, router-version aware | [`swap.ts#L135-L170`](src/swap.ts#L135-L170) |
| The v4 `Quoter` through a read-only `eth_call` | [`quote.ts#L17-L28`](src/quote.ts#L17-L28) |
| Protocol state through `StateView` | [`pool.ts#L64-L82`](src/pool.ts#L64-L82) |
| `PoolId` derivation | [`pool.ts#L39-L52`](src/pool.ts#L39-L52) |
| Addresses and router version from the official SDKs | [`addresses.ts#L46-L67`](src/addresses.ts#L46-L67) |
| Permit2 approvals and EIP-712 permit data | [`approval.ts#L93-L110`](src/approval.ts#L93-L110) |
| `V4PositionManager` mint | [`liquidity.ts#L93-L124`](src/liquidity.ts#L93-L124) |
| Robinhood Chain, which viem does not define | [`chains.ts#L8-L14`](src/chains.ts#L8-L14) |

## Run

```bash
bun run --filter @helico/plugin-uniswap test                       # offline
CHAIN=base bun run --filter @helico/plugin-uniswap smoke           # live, read-only
CHAIN=robinhood bun run --filter @helico/plugin-uniswap discover   # find pools with liquidity
CHAIN=base-sepolia bun run --filter @helico/plugin-uniswap e2e     # sends real transactions
```

`e2e` needs only the native coin: it wraps some, initialises a native/wrapped pool at 1:1 when
none exists, then mints, increases, swaps every single-hop shape, collects and burns.

## Executed on chain

**Base Sepolia, 2026-09-05**, wallet
[`0x7461…88C0`](https://sepolia.basescan.org/address/0x746182D0Cccc5CeFc69853bb0325C850029388C0),
every one `status: success`:

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

**Robinhood Chain Testnet, 2026-09-05**, router 2.1.1, same wallet — a chain neither Uniswap's
deployments page nor the SDKs list, where v4 turned out to be live at the mainnet addresses:

| Step | Transaction |
|---|---|
| Wrap 0.001 ETH | [`0x3e1c…1f53`](https://explorer.testnet.chain.robinhood.com/tx/0x3e1cd6164d6fab46a7a462cc54b0f6aa44e6c14931c84c55b3c16f9429371f53) |
| Initialize the ETH/WETH pool at 1:1 | [`0x6006…aaf8`](https://explorer.testnet.chain.robinhood.com/tx/0x6006b5fed11e252ad91105013ed1827a4d9e8db4c6e805f140eb539b3afeaaf8) |
| Approve WETH → Permit2 | [`0x01ff…9bab`](https://explorer.testnet.chain.robinhood.com/tx/0x01ff88286036d778bc9e83f41696c72e6b68af59bad73b88e505b3546b309bab) |
| Approve Permit2 → PositionManager | [`0xb02a…2747`](https://explorer.testnet.chain.robinhood.com/tx/0xb02afef7bfefb7a14f64d2877e1ecf720f6d07e9b1e2ef4782f9fd6fb67d2747) |
| Mint position NFT #2544 | [`0xdc46…1a2c`](https://explorer.testnet.chain.robinhood.com/tx/0xdc46fc5a14e1e24974d8f069c7aff19757dd95fa56adfcf958e28bd685491a2c) |
| Increase liquidity | [`0x2c0a…bf9f`](https://explorer.testnet.chain.robinhood.com/tx/0x2c0aee7f58ddb35830ddd36733bfe4a7c7a9e71e7bc92c5596156da0693fbf9f) |
| Swap exact-in, 0.00004 ETH → WETH (2.1.1 struct) | [`0xfcb5…50a7`](https://explorer.testnet.chain.robinhood.com/tx/0xfcb5ce655dd3d4f5d7ef1541899064a3756b784c113810f433c8bb0b609050a7) |
| Swap exact-out, ETH → exactly 0.00004 WETH, refund swept | [`0x5e44…1a5e`](https://explorer.testnet.chain.robinhood.com/tx/0x5e447c8312648c4c6326a1fa29e6c22293991d060576d2c6033c4ab4fb401a5e) |
| Approve Permit2 → Universal Router | [`0xc3f1…d351`](https://explorer.testnet.chain.robinhood.com/tx/0xc3f145ce63c8d4fff1e61396f7aadec48d91f208b0f4c0018e586199144ed351) |
| Swap exact-in, 0.00004 WETH → ETH via the Permit2 allowance | [`0x7ac5…41d2`](https://explorer.testnet.chain.robinhood.com/tx/0x7ac5f4312203afcd375c12072960185da62485a442583a5a49575567081441d2) |
| Collect fees | [`0x0c5c…eb8d9`](https://explorer.testnet.chain.robinhood.com/tx/0x0c5cb5a3ff4bc0cf12b6ead0779eca9c08d592551c992dacd06bdce6720eb8d9) |
| Decrease 100 % and burn the NFT | [`0x7ab3…4397`](https://explorer.testnet.chain.robinhood.com/tx/0x7ab35c8ee3db057fdccfbd4e90cf1c20dfcc6aa6ba42e8cbb228942532fc4397) |

Read-only runs elsewhere: Arbitrum One (router 2.0, ETH/USDC 0.05%, both swap shapes accepted via
`eth_call`) and Robinhood Chain mainnet (router 2.1.1, ETH/USDG, same). No e2e on either — the
wallet holds nothing there.

## Do not forget

- `amountOutMinimum` / `amountInMaximum` are the **only** slippage guards. Derive them from a
  fresh quote.
- The `V4_SWAP` input is `V4Planner.finalize()`. `RoutePlanner.inputs` is wrong for it, and wrong
  quietly.
- Native-input exact-output swaps leave ETH in the router, so the encoders add a router-level
  `SWEEP` back to the caller — the v4 action set has no sweep and the router rejects one.
- A route ending in its own input currency nets its deltas out and reverts. Use distinct endpoints.
- Public RPCs lag across nodes and under-estimate gas for position-manager calls; the e2e retries
  with fresh builds and cushions gas.
