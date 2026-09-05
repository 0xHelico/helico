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

Everything it refuses today, unchanged, plus the swap leg. An adversarial review of this plan
**before** any of it was written found the first item below, and it invalidated the plan's
original safety claim. That claim is struck out further down rather than deleted.

### The price the range was checked against is the price the swap moves

`_checkRange` reads the tick before `unlock`. `_assertDelivered` re-reads owner, pool, ticks
and liquidity — **not the price**. In between, the swap moves that price by an amount the agent
chooses. That is the original defect's exact shape, validate one state and execute against
another, reintroduced inside a single transaction.

An agent proposes a range bracketing the current tick, so `RangeOffMarket` passes; pushes the
price out of that range with an oversized swap; and mints single-sided. `_assertDelivered`
waves it through, because every check it makes is about *where the range is*, not where the
price is. The victim pays the slippage and the fee, and lands in a position that is immediately
out of range again — held there by the cooldown.

Four guards, all of them, not one:

1. **The swap's `sqrtPriceLimitX96` comes from the committed range**, not from `MIN`/`MAX`. The
   limit is the sqrt price at `tickLower` when swapping down and at `tickUpper` when swapping
   up, so the pool itself halts the swap at the boundary the user committed to. The price
   cannot be pushed out of the range by anyone, us included. Needs `TickMath.getSqrtPriceAtTick`,
   pure and MIT in v4-core.
2. **Re-read `getSlot0` inside the callback after the swap** and re-assert
   `tickLower <= tick < tickUpper`. Belt to (1)'s braces, at the cost of one `staticcall`.
3. **`amountIn` is capped at what the burn actually returned** on the input side.
4. **`minAmountOut` bounds nothing on its own.** The agent sets it, and a cap the agent sets is
   not a cap. It stays a convenience, not a guard.

### Native currency, or: the pools we are targeting do not work at all

`currency0 == address(0)` on most pools on this chain. `Currency.transfer` for native is a bare
`call` with all gas and empty calldata, so `TAKE_PAIR(vault)` reverts against a contract with no
`receive()` — which the vault is today. **Every re-centre on a native pool would revert before
reaching the swap.**

So: add `receive()`, forward `value` when settling native into the PositionManager
(`modifyLiquiditiesWithoutUnlock` is `payable`), and delete the NatSpec paragraph explaining why
`recenter` is not payable, which stops being true.

### Sweep computed amounts, never a balance

The vault's balance is shared across users. Sweeping `balanceOf(this)` hands one user whatever
another left behind, anything a third party donated, or ETH sent to the `receive()` the previous
point forces us to add. `nonReentrant` serialises calls; it does not partition balances.
Fee-on-transfer and rebasing tokens land in the same hole, and they are plausible on a chain
hosting 20%-fee launch pools.

Sweep amounts the callback computed, and assert both currency balances are zero **on-chain at
the end of the callback**, not only in a test.

### The callback

- Reverts unless `msg.sender == poolManager` and a re-centre is in flight.
- **Must not be `nonReentrant`.** It runs inside `recenter`, which already holds OpenZeppelin's
  single guard flag, so the modifier would make every re-centre revert with
  `ReentrancyGuardReentrantCall`. The in-flight flag is the mechanism; the guard stays on
  `recenter` alone.
- The swap runs on the mandate's own pool, read from `getPoolAndPositionInfo`, never a key the
  caller supplies.

## The claim this plan started with, and why it was wrong

> ~~A mis-sized, sandwiched or badly routed swap yields a position under the floor and the whole
> transaction reverts, so the swap arithmetic has to be right for the action to *succeed*, not
> for the vault to stay *safe*.~~

**`minRetainedBps` is denominated in liquidity, and liquidity is not value.** Worse, the value
required per unit of `L` is *minimised* at exactly the range edge a manipulated price would sit
at. For a range `[1, 4]` minting `L = 100`:

| Price at mint | token0 | token1 | Value in token1 |
|---|---|---|---|
| mid-range | 20.7 | 41.4 | **82.8** |
| pushed to the bottom edge | 50 | 0 | **50** |

Same `L`, same verdict from the floor, 40% less value consumed — the rest bled out as slippage
and fees. The floor is satisfied **more easily** after the manipulation than without it.

The floor bounds *dilution* and never *slippage*. The swap leg has to be bounded on its own
terms, which is what the four guards do.

## The fee problem, which is about this chain and not the design

v4 fees are hundredths of a bip against `MAX_LP_FEE = 1_000_000`, so pools sampled on Robinhood
mainnet carry **20%** (`200000`), **10%** and **6%**. Routing a position through a 20%-fee pool
destroys a fifth of the swapped side before slippage, and no mandate field makes that a good
trade.

No contract can fix it; it is the pool the user chose. What follows is that the demo runs on a
low-fee pool chosen deliberately, and the README says plainly that a re-centre costs a swap
through the position's own pool, so on a high-fee pool it can cost more than it recovers.
Guard (1) helps, since a swap that would cross the range boundary stops there.

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
5. **An agent-sized swap that tries to push the price out of the committed range is stopped at
   the price limit, and the post-swap tick assertion holds.** This is the finding above, and it
   gets the most careful test in the file.
6. A swap sized to leave the position under the floor reverts the whole transaction.
7. A native-currency pool completes end to end, which is what most pools on this chain are.
8. The vault's balance of both currencies is zero after every successful case, asserted on
   chain as well as in the test.

## Report shape

`RecenterParams` gains three fields, appended after the existing bounds and before `deadline`:
`zeroForOne`, `amountIn`, `minAmountOut`. @rifkyeasy sizes them in the enclave from the
withdrawn amounts and the target ratio he already computes, and carries them in the same
`abi.encode(bool act, bytes32 mandateHash, RecenterParams p)` report.

## Not in scope

- Swapping through any pool but the position's own. Routing is a larger surface and buys
  nothing for a re-centre.
- Bounding the agent's slippage choice from the mandate. The price limit bounds the direction
  and extent of the move, which is the part that matters; the residual is ordinary MEV on a
  bounded swap and stays in known limitations.
- A hook in the user's own pool can mint during our callback and consume the `tokenId` we
  reserved, making `_assertDelivered` revert. Fails safe, costs gas, and the hook is committed
  in `poolId` so the user chose it. Known limitation, not a fix.
