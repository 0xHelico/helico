# Helico Arbitrum One

**This subgraph indexes 1inch Aqua, not a Helico contract.** The name says who publishes it; the
manifest says what it reads. Worth stating plainly at the top, because those are not the same
thing here and the difference matters to anyone who opens it expecting our contracts.

Single data source: `0x499943E74FB0cE105688beeE8Ef2ABec5D936d31` — Aqua's deployment on Arbitrum
One, verified on chain rather than read off a README.

## Why this exists

Aqua cannot answer the first question an agent has to ask.

```solidity
mapping(address maker =>
    mapping(address app =>
        mapping(bytes32 strategyHash =>
            mapping(address token => Balance)))) private _balances;

event Shipped(address maker, address app, bytes32 strategyHash, bytes strategy);
event Docked(address maker, address app, bytes32 strategyHash);
event Pulled(address maker, address app, bytes32 strategyHash, address token, uint256 amount);
event Pushed(address maker, address app, bytes32 strategyHash, address token, uint256 amount);
```

The mapping is `private` and four levels deep, so nothing enumerates it. **Not one event
parameter is `indexed`** — checked against real topic0s on chain, where no log carries more than
one topic — so logs cannot be filtered by maker, app or token either. And `rawBalances` requires
a strategy hash you already have.

So *"which mandates does this wallet have, and what is left in each?"* has **no on-chain answer**.
Not a slow one. None. An indexer is the only way to ask, which is what makes this load-bearing
rather than decorative.

## What it does not do

**It never decodes the strategy bytes.** Aqua does not interpret them, and neither should an index
meant to serve every app on it — each app defines its own struct, so decoding here would bake one
layout into something general. `Mandate.strategy` is the raw bytes; a consumer decodes them with
the ABI it owns.

## The schema, and the one field that matters most

`Balance.tokensCount` carries Aqua's own three-state sentinel: **0** never shipped, **1–254**
active, **255** docked.

Without it the schema would model Aqua's *key* correctly and its *state machine* incorrectly.
`dock` zeroes the ledger on chain and emits no per-token event, so an index that only flips a
mandate-level flag keeps advertising allowances the maker has revoked. That was measured before
this was written: two docked mandates showing 3.57 ARB and 1.4 USDC of spendable allowance that
Aqua had already taken away.

Two Aqua behaviours the handlers treat as facts rather than assumptions:

- **`Docked` is not proof of revocation.** `dock` emits it *outside* its token loop, so an empty
  array emits the event and revokes nothing. A mandate shipped with disjoint token sets docks one
  subset at a time. `handleDocked` therefore reads the ledger rather than believing the event.
- **`Pulled` is unauthenticated.** `pull` takes `maker` as an argument rather than using
  `msg.sender`, and has no active-strategy guard, so anyone can emit `Pulled` naming any maker.
  Pulls for mandates we never saw shipped are dropped — recording them would be a way to write
  rows into this index from outside.

## Running it

```bash
npm install
npx graph codegen && npx graph build
npx graph test          # 8 tests, matchstick
```

Deploying needs a Subgraph Studio deploy key, which is not in this repository and should not be:

```bash
npx graph auth <DEPLOY_KEY>
npm run deploy
```

## startBlock

`403010640` — Aqua's first event on this chain, found by scanning `eth_getLogs` forward.

It was 28 million blocks later until a review caught it. The wrong number came from a binary
search on `eth_getCode` with `2>/dev/null`: the public RPC *errors* on state that old rather than
returning empty, and the redirect turned every error into an empty string the search read as "no
code yet". It found the node's pruning boundary, in a gap where Aqua happens to have no events —
which is exactly why it looked right.

Left alone it would have dropped 75 events, 5 of 43 mandates, both `Docked` events, and one of
the two makers on the chain entirely.
