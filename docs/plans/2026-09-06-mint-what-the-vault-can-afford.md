# Mint what the vault can afford, not what the agent guessed

Issue: #78.

## Problem

`_mint` passed the agent's `liquidityToMint` straight to v4. That number is sized off-chain by
the enclave, from a model of a swap that has not happened yet.

The model is `estimateSwap` in `packages/plugins/cre`: fee off the input, one
`getNextSqrtPriceFromInput`, done — **one segment at constant liquidity**. The real pool
crosses initialised ticks and liquidity changes at each one.

Measured on the demo pool, on the run that found this:

| | |
|---|---|
| Pool active liquidity | 65.9e18 |
| Position being re-centred | 87.9e18, larger than the pool at the tick |
| Swap the enclave chose | ~33 ARB |
| Price move that implies | ~88 ticks, over a spacing of 10 |

So the model extrapolated one liquidity value across about nine tick boundaries. The real
price landed elsewhere, the range needed more token1 than the enclave predicted, and the mint
reverted with `MaximumAmountExceeded(67.02e18, 78.15e18)`.

The position was burned and the swap done by then. A whole re-centre lost to arithmetic rather
than to anything the user agreed to — and, because `KeystoneForwarder` calls the receiver
inside a `try`, the transaction still reported success.

## Why the obvious fixes are not the fix

**Widen the caps.** The vault genuinely did not hold what the mint asked for. Widening
`amount0Max`/`amount1Max` moves the failure to `CurrencyNotSettled` and nothing else.

**Raise the slippage.** Tested: 50 → 500 bps moved the requested amount 4.4% and left the cap
unmoved. It is not a function of the budget.

**Improve the model.** Worth doing on its own terms, but it cannot close this. The pool moves
between the enclave's read and the transaction even with perfect arithmetic.

## The shape

The vault does not have to guess. Inside `unlockCallback`, after the swap, it holds the tokens
and can read the price — and `_mint` already read `slot0` and discarded the `sqrtPriceX96`.

```solidity
uint128 affordable = LiquidityAmounts.getLiquidityForAmounts(
    sqrtPriceX96, sqrtLower, sqrtUpper, got0, got1
);
uint256 toMint = affordable < u.p.liquidityToMint ? affordable : u.p.liquidityToMint;
if (toMint == 0) revert NothingToMint();
```

The cap is what keeps the agent's authority intact: this can only ever mint **less** than was
authorised, never more. `minRetainedBps` still decides whether the result was good enough — a
swap that went badly still reverts everything in `_assertDelivered`.

`LiquidityAmounts` is vendored the way `TickMath` is: three pure functions, `Math.mulDiv` for
the 512-bit intermediate. One deliberate difference from upstream — a result that does not fit
`uint128` **saturates** rather than truncating or reverting. Overflow here is not an error: it
happens whenever the price sits a hair below the range's top, which is exactly where the
vault's own swap price limit puts it, and it means only that this side is not the one that
binds. The caller takes a minimum immediately afterwards.

## The mock that was answering wrongly

`MockStateView.getSlot0` returned `0` for the price. Every unit test passed with the change in
place, because zero sends `getLiquidityForAmounts` down the token0 branch and produces a number
too large to bind — so the new line was covered by nothing.

It now returns `TickMath.getSqrtPriceAtTick(tick)`, which is not a second value that can drift
from the tick but the identity v4 itself holds. This is the same hazard as the mock that could
not refuse, in a new place: **a mock that answers wrongly and is never contradicted.**

## How to verify

1. `forge test` — 95 pass with an Arbitrum RPC, 85 pass and 10 skip without.
2. `test_MintsWhatItCanAffordWhenTheAgentAsksForMore` asks for `type(uint128).max` against a
   real pool. No price funds it, so before this change it reverted; now it mints 87.8e18 and
   still clears the mandate's floor.
3. Mutation: replacing `toMint` with `u.p.liquidityToMint` fails exactly that test and nothing
   else.
4. `scripts/check-storage-layout.py` — unchanged, 9 slots. No new state.
5. End to end through `apps/cre/rehearse.sh` (#79) on a fork of Arbitrum One: position
   202752 → 202753, 93.19e18 in and 74.72e18 out — **80.2%**, above the 50% floor — the vault
   empty afterwards, and a second run held on the cooldown.

## Not done here

`estimateSwap` still models one segment. It can no longer break a re-centre, but an enclave
that chooses a swap crossing nine tick boundaries and calls the result a prediction is worth
fixing on its own terms. Separate issue.
