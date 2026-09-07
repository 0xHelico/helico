# `@helico/plugin-1inch`

Concentrated liquidity positions on **1inch Aqua**, priced by 1inch's deployed **SwapVM**.

Aqua is an allowance ledger, not a vault. `ship` writes an entry and moves nothing; `pull` sends
the maker's tokens straight to the recipient. The wallet is never not in custody of its own
money — and one wallet's balance can back several positions at once.

## What it does, and what it deliberately does not

The pricing is 1inch's. `concentrate` is one of thirteen instructions their SDK ships and the
maths lives in their audited, deployed `AquaSwapVMRouter`. This package builds the strategy that
runs there; it does not implement a curve.

```ts
const { order, strategy } = concentratedStrategy({
  base: WETH, quote: USDC,
  priceMin: 2800n * ONE, priceMax: 3200n * ONE,   // ETH between $2,800 and $3,200
  feeBps: 30, maker,
})
await wallet.sendTransaction(shipCall(42161, strategy, [WETH.address, USDC.address], [held, held]))
```

## Reproducing the numbers

```sh
anvil --fork-url https://arb1.arbitrum.io/rpc --port 8549 --silent &
bun scripts/check-aqua.ts
```

```
ship $2,800–3,200   3 Aqua events, 0 token transfers
ship $2,900–3,100   3 Aqua events, 0 token transfers
ship $1,000–9,000   3 Aqua events, 0 token transfers

wallet after    10000000000000000000 WETH   20000000000 USDC
moved           0 WETH   0 USDC

committed       30000000000000000000 WETH against 10000000000000000000 held  —  300%

  $2,800–3,200   1,000 USDC -> 0.337011 WETH   @ $2967.26
  $2,900–3,100   1,000 USDC -> 0.334501 WETH   @ $2989.53
  $1,000–9,000   1,000 USDC -> 0.386875 WETH   @ $2584.81
```

Three positions, one wallet, no deposit. The price spread across the three is the concentration
effect: the same money priced tighter fills better. Over 100% committed is not leverage — the
strategy that fills first gets the tokens and the rest revert inside `pull`. It is a number an
agent has to watch, which is what `overCommitment` is for.

## The three things that go wrong silently

Each of these produces a wrong answer rather than an error, and each has a test.

**The price is a ratio of raw amounts, not human ones** — [`price.ts`](src/price.ts). USDC has 6
decimals and WETH has 18, so ETH at $2,800 is `2800e6`, not `2800e18`. Passing the human number
quoted at `$2,808,428,656,082,635` with zero output. It priced.

**Which token is the numerator flips between chains.** The ratio is `tokenGt / tokenLt`, decided
by comparing addresses as numbers. On Arbitrum One WETH sorts below USDC; on Ethereum it is the
other way round for the same pair. Inverting also reverses the band, and the SDK accepts
`min > max` without complaint.

**`ship` takes the encoded order, not the bare program** — [`strategy.ts`](src/strategy.ts). Aqua
hashes the bytes it is handed; SwapVM looks the balance up under the order's hash. Ship the
program alone and every quote reverts with `SafeBalancesForTokenNotInActiveStrategy` naming a
hash Aqua is holding, which reads as a bug in Aqua rather than in the caller.

## Addresses come from the vendor's SDK

[`addresses.ts`](src/addresses.ts) reads Aqua from `@1inch/aqua-sdk` and the router from
`@1inch/swap-vm-sdk` rather than hardcoding either. Until
[#165](https://github.com/0xHelico/helico/issues/165) this repository targeted `0x499943E7…`,
found by scanning `eth_getLogs` forward for a contract emitting Aqua's events. It found one — a
real Aqua, with real events, that has emitted nothing since block 451,737,844. Scanning for a
contract that behaves like Aqua finds a contract that behaves like Aqua; it cannot tell you
whether anyone still uses it.
