# Compound as a venue, on both sides

**Asked for on 9 September.** Ghoza: *"aku pengen ada integrasi compound"*, and then the sharper
half — *"trus fungsinya cre buat yield optimizer jadi apa kalau komparasinya hanya satu protocol"*.

That is the argument. An optimiser that ranks markets inside one protocol family is not an
optimiser, it is a market picker. Compound has to be reachable from **both** places the product
touches a maker's money, not just the easy one.

## The two places, and why only one of them was blocked

| | what it does | what it calls on the venue |
|---|---|---|
| **Yield** — `HelicoAccount` | parks idle capital; the enclave moves it every five minutes | `supply`, `withdraw` |
| **Cover** — `HelicoMandateSwap`, `HelicoOracleBoard` | unwinds exactly the shortfall inside a taker's swap | the above, plus `getReserveAToken`, `getVirtualUnderlyingBalance`, `getUserAccountData` |

`supplyIdle` and `withdrawIdle` never touch a receipt, so the yield side was never blocked at all —
an adapter answering two functions is enough and nothing deployed changes.

The cover side has one line that blocks it, and it is a **name**, not a shape:

```solidity
// HelicoMandateSwap.sol:349, and the same line in HelicoOracleBoard
require(IReceiptToken(receipt).UNDERLYING_ASSET_ADDRESS() == token, ReceiptIsNotFor(receipt, token));
```

`UNDERLYING_ASSET_ADDRESS()` is Aave's aToken spelling. Comet's base token answers `baseToken()`;
a Compound v2 cToken answers `underlying()`. Neither has this function, so the call reverts and the
venue is refused before any arithmetic happens. `receipt == address(0)` does not rescue it —
`_venueFor` skips a zero receipt rather than trusting it.

## The design: the venue is its own receipt

Both live Aqua apps stay exactly as they are. The trick is that **nothing requires the receipt to be
a different contract from the pool** — the app asks the pool which receipt it issues, and a pool may
answer with itself.

```
CompoundVenue is ERC20, ILendingVenue
  ASSET                       = comet.baseToken()
  UNDERLYING_ASSET_ADDRESS()  → ASSET            ← the name the deployed apps ask for
  getReserveAToken(ASSET)     → address(this)    ← "the receipt I issue is me"
```

Every step of `_cover` then works unchanged, and this is the part worth checking line by line:

```
beforePull = receipt.balanceOf(app)         our ERC20 balance of the app
AQUA.pull(maker, hash, receipt, shares, app)   moves our shares, maker → app
pool.withdraw(tokenOut, deficit, maker)     we burn from msg.sender — which is the app,
                                            and it is our own token, so no approval exists to be missing
refund excess; require(heldNow == beforePull)
```

The reason Aave needs no approval here is that its Pool owns the aToken. We get the same property
for free by being the token.

### Share-priced, deliberately

Shares are fixed and the backing grows, so one share redeems more USDC over time. That makes
`kind = ReceiptKind.SharePriced` and routes it through the `previewWithdraw` conversion #296 added
this morning — the path exists and is tested, and this is the first real venue that uses it.

Rebasing was the alternative and is worse here: it needs an index of its own, and an index that
disagrees with Comet's by one wei is a hole.

First-deposit inflation is handled with the virtual-offset form, `+1` on both sides, rather than a
minimum deposit — a minimum is a number someone has to choose and defend.

### The three reads, and what each becomes

| `ILendingVenue` | Comet |
|---|---|
| `getVirtualUnderlyingBalance(asset)` | `min(ASSET.balanceOf(comet), totalAssets())` — what the market can pay **and** what we hold |
| `getReserveData(asset).currentLiquidityRate` | `getSupplyRate(getUtilization())` × seconds per year × 1e9, per-second 1e18 → annual ray |
| `getUserAccountData(maker)` | debt `0`, and the comment says why: our position is the venue's, not the maker's, so unwinding it cannot liquidate a borrow the maker has of their own |

Read from Arbitrum One today, so the arithmetic is against real numbers rather than assumed ones:

```
comet         0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf   cUSDCv3, decimals 6
baseToken()   0xaf88d065e77c8cC2239327C5EDb3A432268e5831   native USDC — the same one our forks use
getUtilization()                      797601228640330007   79.76%
getSupplyRate(utilization)                     910503685   per second, 1e18  →  2.87% a year
USDC held by comet                         4166308713428   4.17M, the payout ceiling
```

## What this does not do

- **Compound v2 is not covered.** v3 is what is deployed on Arbitrum One, and a cToken adapter is a
  second contract with a different receipt story.
- **`AquaYieldCover`, the SwapVM instruction, stays Aave-only.** It takes one argument — the pool —
  and asks the pool for the receipt, so there is nowhere to put a venue kind. Widening it is a new
  argument and a new router deployment, and it is not on this path.
- **Nothing is deployed by this plan.** The contract, its tests and a fork test against the real
  Comet come first; deploying it and naming it in `config.production.json` is a separate step and a
  separate decision.

## Order of work

1. `contracts/src/CompoundVenue.sol`
2. `IComet` — the slice of Comet this needs, and nothing more, the way `ILendingVenue` is written
3. A mock Comet, and unit tests for the share maths in both directions
4. A fork test on Arbitrum One: supply, accrue, withdraw, and a cover through `HelicoMandateSwap`
   with the maker's wallet empty
5. The workflow: `pools` gains the address, and `chain.test.ts` gains a two-protocol case
6. `docs/deployments.md` and the README, once it is deployed
