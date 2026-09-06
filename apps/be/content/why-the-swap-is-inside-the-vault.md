---
title: "Why the swap is inside the vault"
summary: "Two numbers from a live pool, 0% and 13%, and the design decision they forced."
author: "Helico"
tags: ["vault", "uniswap-v4", "design"]
published_at: 2026-09-06T09:44:00Z
---

An out-of-range position holds one token. If the price has moved above the range, the position is all of the quote token; below it, all of the base. That is not a bug in Uniswap, it is what concentrated liquidity means. It does, though, make re-centring harder than it looks.

## The measurement

Before the vault had a swap, we measured what a burn-and-mint keeps. Take the position's liquidity out, and put it back into a new range that contains the price, funding the mint with whatever the burn returned.

| Position | Liquidity funded | Kept |
|---|---|---|
| Out of range, no swap | 0 | **0%** |
| In range, near the top, no swap | a fraction of one side | **13%** |

The first row is the product's whole reason for existing, and it minted nothing: a range that contains the price needs both tokens, and the burn returned one. The second row is a position that had not even left its range yet, and a move without a swap still lost 87% of it to the wallet as unused tokens.

These are not hypothetical positions; they were measured against a live pool and recorded in the swap plan in the repository.

## The decision

The swap has to happen between the burn and the mint, and it has to happen inside the vault's own control of the pool. So the vault takes the pool's lock itself rather than letting the position manager take it, burns the old position, swaps the side the new range does not want for the side it does, and mints. All in one transaction, all in one unlock.

Three things make that safe rather than merely convenient:

- **The agent may only swap what the burn produced.** Anything beyond that would have to come from another user's balance, and the vault refuses it.
- **The swap is capped at the edge of the range being minted.** The price limit passed to the pool is the sqrt price at the edge of the new range, so the pool halts the swap there and the price cannot be pushed out of the range the vault has just approved. Without this, an agent could move the price after the range check passed and mint single-sided while every post-condition still held.
- **The vault ends every call empty.** It reads its balances before and after, pays the owner exactly what the call produced, and reverts if anything is left behind.

## What it keeps now

On a fork of Arbitrum One, against the real ETH/ARB pool at its real depth, an out-of-range position holding only ARB was re-centred through the vault's swap and came out holding 94.3% of its liquidity in a range that contained the price. The mandate's floor in that run was 50%. The number moves with the pool and the position, which is why the site charts the two rows above and not this one.
