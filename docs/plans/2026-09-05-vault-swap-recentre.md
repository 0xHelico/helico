# Re-centring that works on the positions the product exists for

Issue: #42. Decision: option 1 — the vault swaps inside its own unlock.

## The problem

A Uniswap v4 position that has drifted out of range holds exactly one token: entirely
`currency0` below its range, entirely `currency1` above it. Minting a range that contains the
current price needs both. The vault's plan today is burn-and-mint with no swap, so
`maxLiquidityForAmounts` over the withdrawn amounts is `min(L0, L1)` with one side zero.

Measured by @rifkyeasy against the live pool (tick −65), for `L = 1e15`:

| Old range | Burn returns | Mint over [−560, 440) | Retained |
|---|---|---|---|
| `[100, 1100)` out of range | 48,524,977,311,541 / 0 | **0** | **0%** |
| `[−1000, 0)` in range, near the top | 3,251,223,757,021 / 45,527,510,024,630 | 129,997,405,203,692 | **13%** |

Row one is the product's core case. Since `minRetainedBps` landed (#39) the vault refuses the
dust, so the agent holds — correct, and useless. The vault cannot currently tell a re-centre
from a withdrawal.

These are not hypothetical positions. On Robinhood mainnet at block 55,141,895, token 1900769
sits at `[154000, …)` while its pool trades at tick 152943.

## The shape

`recenter` stops calling `positionManager.modifyLiquidities`, which unlocks the PoolManager
internally and gives us no room between the burn and the mint. The vault takes the lock itself
and does all three steps inside one callback.

```
recenter
  └─ poolManager.unlock(abi.encode(plan))
       └─ unlockCallback                       (only the PoolManager may call)
            1. modifyLiquiditiesWithoutUnlock  DECREASE_LIQUIDITY · BURN_POSITION · TAKE_PAIR(vault)
            2. poolManager.swap                the excess side into the side the new range wants
            3. modifyLiquiditiesWithoutUnlock  MINT_POSITION(owner) · SETTLE · SETTLE · SWEEP(owner)
```

Verified against v4-periphery `main` before writing any of it:

- `modifyLiquiditiesWithoutUnlock(actions, params)` exists and is `isNotLocked` — the
  PositionManager's own reentrancy lock, not the pool's, so it is callable while we hold the
  pool lock.
- `_mapPayer(payerIsUser)` returns `address(this)` when false, and `_pay` transfers from the
  PositionManager's own balance in that case. **So the mint is funded by transferring tokens to
  the PositionManager and settling with `payerIsUser = false` — no Permit2 approval from the
  vault to anyone.** This is the detail that makes the whole thing tractable.
- `OPEN_DELTA = 0` settles the full outstanding debt; `SWEEP` returns what the mint did not
  consume. `MSG_SENDER = address(1)`, `ADDRESS_THIS = address(2)`, which is what the vault's
  existing `FIRST_REAL_ADDRESS = 3` guard already refuses as an owner.

## What the contract must still refuse

Everything it refuses today, unchanged, plus the swap leg:

- `unlockCallback` reverts unless `msg.sender == poolManager`, and unless a re-centre is
  actually in flight. A transient flag set in `recenter` and cleared after `unlock` returns.
- The swap runs on **the mandate's own pool**, never a key the caller supplies. Same `PoolKey`
  the position is in, read from `getPoolAndPositionInfo`.
- `minAmountOut` comes from the agent and bounds the swap. The agent can still choose it badly;
  what stops that mattering is the floor below.
- **`minRetainedBps` is what makes this safe to attempt.** It is measured from the liquidity
  read back after the batch, and it does not care whether the tokens arrived from a burn or a
  swap. A mis-sized, sandwiched or badly routed swap yields a position under the floor and the
  whole transaction reverts. The swap arithmetic has to be right for the action to *succeed*,
  not for the vault to stay *safe*.
- Nothing may be left in the vault when the callback returns. Both currencies are swept to the
  owner, and the test asserts a zero balance rather than trusting the plan.

## The honesty cost

The README says the vault holds nothing. After this it holds nothing **across a transaction**:
tokens exist in the vault between step 1 and step 3 of a single call. That is a real change to
the claim and it goes in the README in those words, not softened.

## How this is tested

**Fork tests, against Robinhood mainnet.** `RealisticPositionManager` models authorisation and
settlement, not the price curve; it cannot model a swap, and asserting anything about the swap
against it would repeat exactly the mistake the twelve-agent audit caught — a mock that cannot
fail, producing a green suite for a broken contract.

The unit suite keeps covering what it already covers. The swap is proven on a fork or not at
all:

1. A real out-of-range position is re-centred, and the new position ends in range with at least
   `minRetainedBps` of the old liquidity.
2. The same, in range, matching the 13% row above without a swap and comfortably above it with
   one.
3. `unlockCallback` called directly by anyone reverts.
4. `unlockCallback` called by the PoolManager with no re-centre in flight reverts.
5. A swap sized to leave the position under the floor reverts the whole transaction.
6. The vault's balance of both currencies is zero after every successful case.

## Report shape

`RecenterParams` gains three fields, appended after the existing bounds and before `deadline`:
`zeroForOne`, `amountIn`, `minAmountOut`. @rifkyeasy sizes them in the enclave from the
withdrawn amounts and the target ratio he already computes, and carries them in the same
`abi.encode(bool act, bytes32 mandateHash, RecenterParams p)` report.

## Not in scope

- Swapping through any pool but the position's own. Routing is a larger surface and buys
  nothing for a re-centre.
- Bounding the agent's slippage choice from the mandate. Still listed under known limitations.
