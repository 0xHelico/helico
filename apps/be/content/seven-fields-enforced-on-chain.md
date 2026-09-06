---
title: "Seven fields, every one enforced on chain"
summary: "The mandate is seven numbers. Here is what each one means, and the line in the vault that refuses a move that breaks it."
author: "Helico"
tags: ["vault", "mandate", "solidity"]
published_at: 2026-09-06T09:42:00Z
---

The mandate is a small struct: seven fields, committed with `keccak256(abi.encode(mandate))` when you set it. The vault does not store your intentions in prose; it stores numbers it can check. Below, each field, what it protects, and where the vault refuses.

Line references are pinned at commit `154bcab`, the revision they were read from, so they stay true when the file moves on.

## poolId

The only pool this mandate permits. Both the position you hold and the range the enclave proposes must hash to it. A verdict that names another pool reverts with `PoolNotPermitted` (line 489).

## rangeWidthTicks

The exact width of the range to re-centre into, in ticks. Ticks rather than basis points, because a tick is what the pool measures in, and committing the pool's own unit removes the drift between what an agent computes off chain and what the contract checks. The width must be a whole number of the pool's tick spacings; `setMandate` refuses one that is not rather than snapping it, so the range you get is the range you signed. A proposed range of any other width reverts with `RangeWidthMismatch` (line 733).

## minImprovementBps

How much closer to the market price the new range must sit, in basis points of the distance the old one sits at. Without it an agent could move the range sideways every cooldown for as long as the mandate lasts, paying gas and fees out of your position each time. `NotEnoughImprovement` (line 747).

## cooldownSeconds

The minimum time between two moves, counted from the last one the vault executed. It cannot be zero: a zero cooldown lets an agent re-centre repeatedly in one block. `CooldownNotElapsed` (line 473).

## maxLiquidity

A cap on the liquidity one move may touch. Measured from the position at the time of the move, not declared by the agent. `LiquidityTooLarge` (line 486).

## expiry

After this timestamp the mandate is dead and every re-centre reverts, whatever else is true. `MandateExpired` (line 468).

## minRetainedBps

The share of your liquidity a move must keep, read back from the position the vault actually minted rather than from what the agent asked for. Every other check is about where value went; this one is about whether the earning position survived. `LiquidityNotRetained` (line 718).

## And the price

One rule that is not a field: the new range must contain the current tick. Constraining the width without constraining the location would leave the product open to a band parked where no trade will ever reach it. `RangeOffMarket` (line 739).

## What that adds up to

Two entry points, `recenter` and `recenterWithSignature`, end in the same checks. The swap between the burn and the mint is capped at the edge of the range you signed, so the pool itself halts it there. And the mandate's hash rides in every verdict, so an enclave that decided against terms you have since replaced is refused rather than executed against the new ones.
