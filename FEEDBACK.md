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
- Robinhood Chain only has Universal Router 2.1.1, whose v4 swap structs carry
  `minHopPriceX36`. `V4Planner` supports it through an optional `urVersion` argument, but
  nothing in the SDK types ties a chain to a router version: `UNIVERSAL_ROUTER_ADDRESS(V2_0,
  4663)` simply throws. A `latestUniversalRouter(chainId)` helper returning address and
  version would remove a whole class of "works on Base, throws on Robinhood" bugs.
- Uniswap v4 is deployed on Robinhood Chain Testnet (46630) at the mainnet addresses
  (PoolManager, Quoter, and StateView bytecode is identical), but neither the deployments
  page nor `@uniswap/sdk-core` lists it. Documenting it would let people test there before
  spending real ETH on the mainnet.
- `SENDER_AS_RECIPIENT` and `ROUTER_AS_RECIPIENT` live in `@uniswap/universal-router-sdk`'s
  constants, but only the second is exported from the package index.

## Building a position manager on top of v4

A second body of work — a non-custodial contract that re-centres someone's position under rules
they commit to on chain — ran into a different set of edges. These cost the most time, so they
are listed in the order we hit them rather than by severity.

**There is no re-range action, and that has consequences the docs do not draw out.** Moving a
position is `DECREASE_LIQUIDITY` + `BURN_POSITION` + `MINT_POSITION`, and the mint issues a
*new* `tokenId`. Anything keyed to the old id is silently orphaned: our first design stored a
user's policy against the tokenId, so the very action it authorised destroyed the thing it was
attached to. A sentence in the liquidity guide saying that re-ranging is identity-destroying,
and that `nextTokenId()` is how you learn the new id, would have saved a rewrite.

**An out-of-range position holds exactly one token, so re-centring it needs a swap.** Below its
range a position is entirely `currency0`; above, entirely `currency1`. Minting a range that
contains the price needs both, so `maxLiquidityForAmounts` over the withdrawn amounts is
`min(L0, L1)` with one side zero — the mint is **zero**. For the case a keep-in-range product
exists for, burn-and-mint alone cannot work. We measured it before believing it: at tick −65, a
position of `L = 1e15` at `[100, 1100)` withdraws 48,524,977,311,541 of one token and can mint
nothing at all. This is the single most important thing a builder of an LP manager needs to
know, and we found it by arithmetic rather than by reading.

**`modifyLiquidities` takes the pool lock itself, which leaves no room for that swap.** The way
through is `poolManager.unlock` from your own contract and then
`modifyLiquiditiesWithoutUnlock`. That function exists and is public, but nothing says what it
is *for* — its NatSpec describes the mechanism, not the situation. "Use this when you need to
interleave your own pool operations with position operations" would point people straight at
it.

**`_mapPayer(payerIsUser: false)` makes the PositionManager pay from its own balance.** This is
the detail that made an in-callback swap tractable: the mint can be funded by transferring
tokens to the PositionManager and settling, with no Permit2 allowance from our contract to
anybody. It is load-bearing and, as far as we could find, documented nowhere outside the
source.

**Native currency reverts silently against a contract without `receive()`.** `Currency.transfer`
for the zero address is a bare `call` with all gas and empty calldata, so `TAKE_PAIR` to a
contract recipient fails with `NativeTransferFailed` and no hint about the cause. On the chain
we target, most pools have `currency0 == address(0)`, so this was not an edge case — it was
every re-centre.

**`tickUpper` is exclusive, which bites on `sqrtPriceLimitX96`.** Limiting a swap to
`getSqrtPriceAtTick(tickUpper)` lets it land on exactly that tick, which the subsequent mint
then rejects — the guard reverts the transaction precisely when it does its job. The limit has
to be one below. Obvious once written down; not obvious while writing it.

**LP fees are hundredths of a bip, and pools in the wild use the whole range.** `MAX_LP_FEE` is
`1_000_000`, so a `fee` of `200000` is **20%**, not 20 bps. Pools on Robinhood Chain mainnet
carry 20%, 10% and 6%. Anything that swaps through a position's own pool has to check the fee
before it decides the trade is worth making, and a reader who pattern-matches `3000` → 0.30%
will misread `200000` by three orders of magnitude.

**The `poolId` inside `PositionInfo` is not the canonical `PoolId`.** It is truncated to 25
bytes for an internal lookup. The library says so; a comparison against
`keccak256(abi.encode(PoolKey))` will still be written by somebody, and it will fail in a way
that looks like a hashing bug.

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
- Ship the router version alongside the address in the SDK's per-chain config, and list the
  Robinhood Chain Testnet deployment.
- State in the liquidity guide that re-ranging destroys the `tokenId`, and that anything built
  on top has to follow the new one.
- Say plainly, where people will look before building a keep-in-range product, that an
  out-of-range position is single-sided and cannot fund a two-sided range without a swap. It
  changes the architecture, not just the implementation.
- Document what `modifyLiquiditiesWithoutUnlock` is for, and that `payerIsUser: false` settles
  from the PositionManager's own balance. Together they are the supported way to interleave a
  swap with position operations, and both currently read as internals.
- Note in the periphery docs that a contract receiving native currency from `TAKE_PAIR` or
  `SWEEP` needs `receive()`, since the failure is a bare `call` with no diagnostic.
- Put the fee unit next to the fee field in the docs. `MAX_LP_FEE = 1_000_000` is stated in the
  library, but every example uses `3000`, and pools charging 20% exist.
