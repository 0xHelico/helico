# The enclave manages several assets, and they see each other

**Asked for on 10 September.** Ghoza: *"tambahkan supaya enclave bisa mengelola multi asset"*, and then
the part that decides the shape — *"bikin keduanya bisa saling melihat dan bisa bekerja."*

## Why the cheap version was refused

Two workflows, one per asset, is a config change and no code. It was refused for a reason worth
writing down: **they cannot see each other.** Each would read one asset's idle balance, size one
buffer, and act — so a policy about the account's *total* idle capital cannot exist, and on a run
where both want to move, both move. `HelicoAccount.nonce` is strictly sequential, so the second
signature is spent against a nonce the first already used and the move reverts.

One workflow that reads every asset and emits one move is the version that can hold a rule about
the account rather than about one token in it.

## What changes

| | |
|---|---|
| `config.asset` | becomes `assets`, a list. One entry behaves exactly as today |
| `readAccountState` | batches per **asset × pool** rather than per pool |
| `AccountState` | gains `assets: AssetState[]`; `idle` and `venues` move inside each |
| the decision | runs per asset, then **one winner is chosen across them** |

`decideIdleMove` itself does not change. It is already pure and already about one asset; the new
function ranks its verdicts.

## The decision that cannot be made quietly

**One move leaves per run.** That is not a simplification — `HelicoAccount.nonce` is strictly
sequential and one signed statement authorises exactly one call, which is why a migration already
takes two runs today. So with several assets the enclave must answer a question it has never had
to: *whose* move happens this run.

Ranking needs a common unit, and the honest options differ in what they cost:

1. **By rate gap, in basis points.** Dimensionless, so USDC and WETH compare without a price. But a
   large gap on a small balance beats a small gap on a large one, which is the wrong answer
   whenever the balances differ a lot — and they will.
2. **By value moved.** Correct, and needs a price for every asset. Chainlink feeds are already read
   by `HelicoOracleBoard`, so the machinery exists; the cost is a feed per asset in config, one
   more read per asset per run, and a staleness rule — a stale feed must hold rather than rank.
3. **By rate gap × amount, in the asset's own units.** Cheap and wrong: it compares 5·10¹⁸ against
   5·10⁶ and always picks the eighteen-decimal asset.

**This plan takes (2), with (1) as the fallback when a feed is stale or unconfigured.** A hold is
the safe direction: not moving costs the yield difference for one five-minute tick, and moving the
wrong asset spends the only move available on the smaller correction.

Option 3 is written down because it is the one that looks reasonable in a diff and is not.

## What is deliberately not in this

- **No cross-asset rebalancing.** The enclave will not sell WETH to hold more USDC. It places what
  the account already holds of each asset, and nothing here decides what the account should hold.
- **No new venues.** Aave already serves WETH through the pool that is already permitted. Compound
  needs a second `CompoundVenue` for `cWETHv3` and Morpho's WETH vaults hold $854 between them —
  both are #340, not this.

## Order of work

1. `assets` in the config schema, with `asset` still accepted and folded into it
2. `readAccountState` per asset × pool, and `AssetState`
3. `decideAcrossAssets`, ranking by value with the rate-gap fallback
4. `index.ts` emits the winner
5. Tests: two assets that disagree, a stale feed, and one asset behaving exactly as today

## What the second venue found, after the fact

**10 September 2026, once `cWETHv3` was deployed at `0xb0A125F5…18cD` (#340).**

This plan carried an assumption it never said out loud: that a market listed in `pools` answers for
every asset in `assets`. That was true of everything the plan could see. Aave's Pool serves every
reserve, so `getReserveAToken(USDC)` and `getReserveAToken(WETH)` both answer from one address, and
the whole `asset × pool` grid in step 2 was dense.

It is not true of the venues. A `CompoundVenue` or a `MorphoVenue` holds exactly one market, and
`getReserveAToken` on any other asset **reverts** — deliberately, so that a venue cannot be asked
about capital it has no way to move. Measured at the live addresses before anything was changed:

```
                 getReserveAToken(USDC)   getReserveAToken(WETH)
aave             0x724dc807…C637          0xe50fA9b3…28c8
compound USDC    0x1eC57cE1…BB2E          revert
morpho USDC      0xBBa798A6…c9A29         revert
compound WETH    revert                   0xb0A125F5…18cD
```

And `ethCallBatch` throws on the first reply without a `result`, which is the behaviour
`readAccountState` documents and wants: *"a view missing one market's rate is a view that would
pick the best of the rest and call it the best."*

Put together: **adding WETH to `assets` would not have earned less, it would have stopped every
run.** Every five minutes, inside a TEE, with the failure landing where nobody was watching for it.
The grid was never dense; the plan just never had a sparse row to notice.

### The fix, and the one that was refused

A market may now name the assets it lists. A market that names none lists them all, which is what
an Aave Pool is and what keeps every earlier configuration meaning what it meant.

The alternative — **treat a revert as "this market does not list this asset"** — needs no config
change at all and is the one that looks reasonable in a diff. It is wrong for the same reason the
batch throws in the first place: a dropped RPC call, a paused venue, a market mid-upgrade and a
market that genuinely does not hold the asset all arrive as the same silence, and the run would
carry on comparing whatever was left and call it the best. Written down, a revert stays a failure.

Two refusals came with it, because a scope has two ways to be wrong:

- an asset no market lists — capital the enclave watches and can never place, which reads as a
  decision to hold on every run, forever, green
- a market listing no asset the account holds — usually a typo in an address, and always a market
  that will never be compared to anything

### What this cost

`STRIDE`. Every asset used to spend `1 + pools.length * VENUE_READS` calls, so its slice could be
multiplied out; now an asset scoped to fewer markets shifts everything after it, and the reader
keeps a cursor instead. That is exactly the arithmetic the earlier mutation test was written
against — forcing `base` to a constant left all three shape tests green — so the same shape is
checked again with values, at slices that are no longer equal in length.
