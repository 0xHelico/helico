---
title: The Graph
---

*Moved out of the root README on 12 September so that file stays short enough to be read. Nothing
here was rewritten: this is the same text, the same measurements and the same pinned links, in a
place a reader reaches when they want the depth rather than the claim.*

## The Graph

Aqua cannot answer the first question an agent has to ask.

```solidity
mapping(address maker =>
    mapping(address app =>
        mapping(bytes32 strategyHash =>
            mapping(address token => Balance)))) private _balances;

event Shipped(address maker, address app, bytes32 strategyHash, bytes strategy);
```

The mapping is `private` and four levels deep. **No event parameter is `indexed`**, so logs cannot
be filtered by maker, app or token. And `rawBalances` needs a hash you already have. So *"which
mandates does this maker have, and what is left in each?"* has **no on-chain answer at all**. That is
what makes an indexer load-bearing here rather than decorative.

The subgraph is in [`subgraph/`](../../subgraph/), deployed to Subgraph Studio and indexing the live
Aqua. `bun scripts/check-subgraph.ts` **measures the claim above before answering it**. It asks
the chain for `Shipped` logs and counts the topics on them:

```
Shipped logs in the last 200,000 blocks: 1
topics per log: 1–1
→ only topic0, the signature. No parameter is indexed, so logs cannot be
  filtered by maker, by app or by token. Only by "a Shipped happened".
```

If any parameter were indexed a log would carry two topics or more, and the script would say so
instead. Then it asks the subgraph the same question. Against the busiest maker on the chain,
not ours:

```
maker     0xef9f7f4006fe95afede04f6916e72556a957ebbc
mandates  54, of which 11 still active, across 5 tokens
```

Fifty-four strategies under one address (read 12 September), and no way on chain to learn any of them exist. Docked
ones come back marked docked rather than merely empty, which is Aqua's own three-state sentinel.

> **Two mistakes got it here, and one query catches both.** It indexed a real-but-wrong Aqua
> ([#165](https://github.com/0xHelico/helico/issues/165)), then deployed the fix to a Studio slug
> nobody queries ([#183](https://github.com/0xHelico/helico/pull/183)). Both times the endpoint
> answered, `hasIndexingErrors` was false, and `_meta` tracked the head. **The oldest entity an
> endpoint serves cannot predate the first log of the contract it indexes**. That is what
> separates "this endpoint is up" from "this endpoint read the contract we meant".

We also got the Aqua address wrong twice and are keeping both corrections rather than editing them
away. First we said Aqua on Arbitrum was empty, from a query asking for the last 10,000,000 blocks
when the newest event was 49 million old. Then the address itself turned out to be a different
deployment 1inch does not call Aqua. The canonical one is
`0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a`, confirmed by their SDK constant and by the deployed
router's own bytecode, not by event counts, which pick the wrong contract, or by recent event
counts, which pick the right one by luck.


**And 1inch says the same thing, which is better evidence than our saying it.** Their Aqua
documentation, under Data & Analytics:

> A hosted subgraph is not currently available. Build a reference indexer over the five
> registry/router events keyed on `(maker, app, strategyHash)`.

We indexed four of those five. `Shipped`, `Docked`, `Pulled` and `Pushed` are on the Aqua registry;
the fifth, `Swapped`, is on the router, and there was no router data source at all. There were
**340** of them at `0x111111338c…` since Aqua's deployment when the data source was written. The
most recent two minutes before the query, so it landed with 340 fills nobody could otherwise
query, and the live index serves every one since.

Its `startBlock` is the router's own first log, an `OwnershipTransferred`, so it is the deployment
and exact rather than a safe underestimate. Bisected with `eth_getLogs`, never `eth_getCode`: a
pruned archive answers *"state is not available"*, and a search that reads that as "no code yet"
returns the node's pruning boundary instead of a deployment.

**It is keyed honestly, and that is the part worth reading.** `Swapped` carries `orderHash`, the
router's identifier for the order it executed, which is *not* the `strategyHash` everything else in
the schema keys on and is not derivable from the event. So there is **no edge from `Fill` to
`Mandate`**: a join on two hashes that are not the same hash would be a lie that reads as data. The
`maker` edge is real, because the event carries the address.

| What | Where |
|---|---|
| The fifth event, and the four before it | [`subgraph/subgraph.yaml`](../../subgraph/subgraph.yaml) |
| A fill written as what the log carries, and nothing it does not | [`router.ts#L18-L45`](https://github.com/0xHelico/helico/blob/85fa79fa4d82f92b7f55c027c1fe2932043d716b/subgraph/src/router.ts#L18-L45) |
| Why `Fill` has no edge to `Mandate` | [`subgraph/schema.graphql`](../../subgraph/schema.graphql) |
| The question the chain cannot answer, asked and paged to the end | [`mandates.ts#L115-L141`](https://github.com/0xHelico/helico/blob/f6f2fc6695e030d8a6918a863470299fcb8dd179/packages/plugins/thegraph/src/mandates.ts#L115-L141) |
| A docked mandate kept distinct from an empty one | [`mandates.ts#L62-L81`](https://github.com/0xHelico/helico/blob/f6f2fc6695e030d8a6918a863470299fcb8dd179/packages/plugins/thegraph/src/mandates.ts#L62-L81) |
| What is still spendable, summed across live mandates | [`mandates.ts#L84-L94`](https://github.com/0xHelico/helico/blob/f6f2fc6695e030d8a6918a863470299fcb8dd179/packages/plugins/thegraph/src/mandates.ts#L84-L94) |
| Studio without a key, the gateway with one | [`client.ts#L59-L95`](https://github.com/0xHelico/helico/blob/f6f2fc6695e030d8a6918a863470299fcb8dd179/packages/plugins/thegraph/src/client.ts#L59-L95) |
| The accounts the enclave discovers from the index | [`subgraph.ts#L191-L205`](https://github.com/0xHelico/helico/blob/f6f2fc6695e030d8a6918a863470299fcb8dd179/packages/plugins/cre/src/subgraph.ts#L191-L205) |
| The subgraph itself | [`subgraph/`](../../subgraph/) |
