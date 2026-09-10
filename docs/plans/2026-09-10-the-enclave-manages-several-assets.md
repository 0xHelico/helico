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
