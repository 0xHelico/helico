---
title: "The agent that holds a buffer"
summary: "On 8 September Helico stopped keeping a Uniswap v4 position in range and started keeping an account's idle capital earning. What changed, what did not, and the number that decides."
author: "Helico"
tags: ["product", "chainlink-cre", "1inch", "thegraph"]
published_at: 2026-09-08T16:20:00Z
---

The four posts below this one describe a product we no longer build. They are still here, with a
note at the top of each, because deleting writing that was true when it was written is a worse
habit than being seen to change your mind.

Here is what changed.

## What the agent does now

It decides how much of your account's idle stablecoin should be earning in a lending market you
allow-listed, and how much has to stay liquid. Most runs it decides to do nothing.

The old product kept a concentrated liquidity position inside its price range. The new one keeps a
**buffer** — and the buffer is the interesting part, because it is not a number you set once.

## Why a buffer is harder than a target

Say you want 80% of your capital earning. That is a target, and a target alone would put 80% to
work and leave 20% liquid whatever else is true.

But your account is also a maker on [1inch Aqua](https://1inch.io). You have shipped a mandate: a
ceiling on how much of each token a swap may take out of your wallet, an expiry, and one named
agent contract. Aqua is an allowance ledger rather than a vault, so shipping that mandate moved no
tokens at all — your money never left. The consequence is that a swap against it is served
**from your wallet, at the moment it fills**.

So if the agent has put everything to work, a swap the mandate permits arrives at a wallet that
cannot pay it. What happens then is not a failure exactly — the swap unwinds a lending position
inside itself to cover the shortfall — but it is slower, and it can be refused outright when the
market it would draw on cannot pay.

The buffer exists to make that path rare. And it has to be sized from what your mandates could
actually be asked to pay, which changes every time you ship one.

## The question the chain cannot answer

Here is the problem: *which mandates does this wallet have, and what is left in each?*

Aqua's balances live in a mapping that is `private` and four levels deep, so nothing enumerates
it. Reading one needs a strategy hash you already hold. And not one parameter of its four events
is `indexed`.

That last one is worth measuring rather than believing. Ask the chain for Aqua's `Shipped` logs
and count the topics on them:

```
Shipped logs in the last 200,000 blocks: 1
topics per log: 1–1
→ only topic0, the signature.
```

One topic — the event signature. Nothing to filter on. You cannot ask for a maker's logs, because
maker is not indexed; you can only ask for "a Shipped happened, somewhere, to somebody".

So the answer is not on chain, at any speed. An indexer is not a faster way to ask this. It is the
only way, which is why a subgraph is load-bearing here rather than decorative.

## What the enclave does with it

The decision runs inside a Chainlink CRE confidential workflow. From in there it reads your
account and every market you permitted, asks our subgraph what your live mandates could still
demand, and raises the liquid floor to it.

The floor may only be **raised**. An index that is unreachable, empty, or lagging can therefore
never make the decision wrong — only less good. It falls back to the floor you set yourself, and
the run says which number it used.

What stays inside the enclave is the policy: the target split, that floor, and the deadband below
which a move is not worth its own gas. Those are the strategy. Only the decision comes out.

## What did not change

The shape of the safety argument, which is the part worth keeping:

**The agent has two calls, and neither takes a recipient.** `supplyIdle` credits your account.
`withdrawIdle` returns to it. There is no address parameter to redirect, so the worst a corrupted
decision or a hostile relayer can do is move your own money between your own places.

**You name what it may touch.** One call says who may move it; another says which markets. Revoke
a market and the way *in* closes while the way *out* stays open — so the agent unwinds what is
there instead of holding beside money you said you wanted back.

**The way out cannot be walled up.** It lives in the proxy, outside any implementation. The code
can be replaced entirely; that door cannot be removed.

## Where it is

The account factory, the Aqua app and a SwapVM router carrying one instruction of ours are
deployed and verified on Arbitrum One. The subgraph is live. The workflow is registered.

And nobody has opened an account on it yet — so the deployed workflow reaches its logic and holds,
every run, waiting for something to manage. That is a true sentence rather than a modest one, and
it is the kind we would rather write than the alternative.
