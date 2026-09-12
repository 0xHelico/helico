# `@helico/plugin-thegraph`

The Graph, for the question Aqua cannot answer about itself.

```solidity
mapping(address maker =>
    mapping(address app =>
        mapping(bytes32 strategyHash =>
            mapping(address token => Balance)))) private _balances;

event Shipped(address maker, address app, bytes32 strategyHash, bytes strategy);
```

`private` and four levels deep, so nothing enumerates it. **No event parameter is `indexed`**, so
logs cannot be filtered by maker, app or token, only by topic0. And `rawBalances` needs a hash you
already hold.

So *"which mandates does this maker have, and what is left in each?"* has **no on-chain answer**.
Not a slow one. None. For an agent deciding what it may do for a wallet that just connected, that
is the problem rather than a performance detail, which is what makes an indexer load-bearing here
instead of decorative.

## Use it

```ts
import { HELICO_AQUA, makerMandates, spendable } from '@helico/plugin-thegraph'

const answer = await makerMandates(HELICO_AQUA[42161], maker)
answer.mandates          // one row per strategy, with its per-token balances
answer.active            // how many are still live
answer.spendable         // token → total still spendable across the live ones
```

| | |
|---|---|
| [`mandates.ts`](src/mandates.ts) | `makerMandates`, paged; `toMandates`; `spendable` |
| [`pool.ts`](src/pool.ts) | `poolHistory` and `drifted`, against Uniswap v4's published subgraph |
| [`client.ts`](src/client.ts) | `query`, and `endpoint`, Studio takes no key, the gateway takes only a key |
| [`types.ts`](src/types.ts) | `HELICO_AQUA` and `UNISWAP_V4`, the subgraphs this package knows |

The subgraph itself is in [`subgraph/`](../../../subgraph/). `bun scripts/check-subgraph.ts` shows
what the live endpoint returns.

## Three things this package is careful about

**A docked mandate and an empty one are not the same.** Aqua zeroes the ledger on chain and emits
no per-token event, so an amount of zero and a revocation look identical from outside. The schema
keeps Aqua's own three-state sentinel, and `spendable` counts only what can still be spent.

**A partial page is indistinguishable from a short one.** `makerMandates` pages to the end rather
than taking the first thousand rows and calling it the answer.

**This package never reads `process.env`.** The endpoint is passed in, because the enclave that
calls this has no environment to read.

## The mistake worth remembering

The endpoint answering, `hasIndexingErrors` being false, and `_meta` tracking the chain head are
all true of a subgraph indexing **the wrong contract**. That happened twice here
([#165](https://github.com/0xHelico/helico/issues/165),
[#183](https://github.com/0xHelico/helico/pull/183)).

The check that catches it: **the oldest entity an endpoint serves cannot predate the first log of
the contract it indexes.**
