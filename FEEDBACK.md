# Feedback — Uniswap

Required for the Uniswap Foundation bounty at ETHOnline 2026, together with the
[Uniswap Developer Feedback Form](https://developers.uniswap.org/hackathon-feedback), which
must link to this file. Everything below was observed while building
[`packages/plugins/uniswap`](packages/plugins/uniswap/) on 2026-09-05.

## What we used

| Stack component | Used? | Notes |
|---|---|---|
| Uniswap API | no | Needs an API key from the developer portal; we had none, so we could not verify anything built on it and chose the on-chain path instead |
| AMM (v2 / v3 / v4) | v4 | `StateView`, v4 `Quoter`, Universal Router `execute` with `V4_SWAP`, on Base |
| v4 Hooks | no | |
| CCA | no | |
| Uniswap AI skills | yes | Read `swap-integration`, `v4-sdk-integration`, `viem-integration`, `pay-with-any-token` from `Uniswap/uniswap-ai` @ `936734c` before writing code |

## What worked well

- `@uniswap/sdk-core` ships the v4 addresses (`CHAIN_TO_ADDRESSES_MAP`) and
  `@uniswap/universal-router-sdk` ships `UNIVERSAL_ROUTER_ADDRESS`. They matched the
  deployments page for every chain we checked, so nothing had to be hand-copied.
- `V4Planner` + `RoutePlanner` produced calldata the Universal Router accepted on the first
  try, verified with a plain `eth_call` from an address that holds ETH. That is a great way to
  prove a swap path without a funded wallet, and worth a line in the skills.
- The skills are precise about the Trading API contract (header names, string chain ids,
  `x-agent-info`), and `swap-integration` states the API key requirement up front.
- All three SDKs load under bun with no shims.

## What was difficult

- `RoutePlanner.addCommand(CommandType.V4_SWAP, [planner.actions, planner.params])` fills
  `RoutePlanner.inputs` with three bytes. Passing that to `execute` reverts. The working input
  is `V4Planner.finalize()`, which the `v4-sdk-integration` snippet uses, but nothing says
  that `RoutePlanner.inputs` is wrong here, so it reads like an equivalent choice. It is not.
- `v4-sdk-integration` shows the Quoter with ethers `callStatic`, while the recommended
  client is viem. Translating the `QuoteExactSingleParams` tuple to a viem
  `parseAbi` struct plus `simulateContract` took a detour through `IV4Quoter.sol`.
- `developers.uniswap.org` redirects non-browser fetches to `llms.mdx` pages. Some exist
  (`/docs/uniswap-ai/skills`, `/docs/protocols/v4/deployments`), some return 404
  (`/docs/uniswap-ai`, `/docs/trading-api`), so an agent following links dead-ends.
- The recommended path for backends, the Trading API, is the one path a hackathon team
  cannot verify without registering for a key first.
- `V4Planner` happily encodes `Actions.SWEEP`, but the Universal Router's v4 action set has
  no sweep: the router reverts with `UnsupportedAction(0x14)`. Refunding unused native input
  after an exact-output swap needs the router-level `SWEEP` command instead, which
  `RoutePlanner` encodes correctly. Nothing in the skills or the SDK types says which actions
  the router accepts.
- The `v4-sdk-integration` skill imports `encodeMultihopExactInPath` from `@uniswap/v4-sdk`;
  version 2.3.3 does not export it. The `PathKey` struct has to be built by hand.
- A multi-hop route that ends in its own input currency (ETH → USDC → ETH) quotes fine but
  reverts in the router with `V4TooLittleReceived(min, 0)`, because `SETTLE_ALL`/`TAKE_ALL`
  work on net deltas. Obvious in hindsight, invisible in the docs.
- `https://mainnet.base.org`, viem's default Base RPC, answers HTTP 429 after about ten
  calls in a row; the smoke script had to move to another public endpoint.
- On Base Sepolia, a `collect` (`DECREASE_LIQUIDITY` by 0 plus `TAKE_PAIR`) through the
  PositionManager ran out of gas at the node's own estimate (110k estimated, 162k needed a
  block later). A note in the liquidity docs that estimates for position-manager calls need a
  cushion would save a reverted transaction.

## Suggestions

- In the SDK docs and the skill, say explicitly that `V4Planner.finalize()` is the V4_SWAP
  input and that `RoutePlanner.inputs` must not be used for it, or make `RoutePlanner`
  encode it correctly.
- Add a viem version of the Quoter example next to the ethers one.
- Mention `CHAIN_TO_ADDRESSES_MAP` and `UNIVERSAL_ROUTER_ADDRESS` in `v4-sdk-integration`
  instead of pointing at the deployments page only.
- Fix the `llms.mdx` 404s, or list which pages are available to non-browser clients.
- A rate-limited, keyless tier of the Trading API for read-only `quote` calls would let
  hackathon teams verify the recommended path before they commit to it.
- Type the `Actions` a `V4Planner` may carry per execution context (router vs position
  manager), or document the router's supported subset next to `handlerInTee`-style examples.
- Update the `v4-sdk-integration` multi-hop snippet to the current SDK surface.
