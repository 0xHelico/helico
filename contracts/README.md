# Contracts

`HelicoVault` enforces a user's committed mandate on an agent that re-centres their Uniswap v4
liquidity position.

The vault holds nothing — no tokens, no NFTs. The user keeps their position NFT and approves
the vault to act on it; **revoking that approval, or calling `revoke`, ends the agent's
authority immediately** and cannot be blocked by the agent, the guardian, or a pending upgrade.

## What a rogue agent can do

This is the honest version of the security claim, and the one the tests check.

Holding `AGENT_ROLE` lets you re-range a position **whose owner committed a mandate**, into a
band of the committed width, containing the current market price, measurably closer to it than
the band already is, no more often than the cooldown allows, before the mandate expires.

The new NFT and every token that leaves the old position go to the position's owner, because
those are the only destinations the contract will write into a payload. There is no path that
pays an agent, and no path that touches a position whose owner did not commit a mandate.

## What the contract decides

The agent chooses *whether* and *where* to re-centre. The contract decides what is allowed:

| Check | Rejection |
|---|---|
| The named owner committed a mandate, and still owns the position | `MandateInactive`, `NotPositionOwner` |
| The position is in the committed pool | `PoolNotPermitted` |
| Ticks ordered and aligned to the pool's spacing | `TicksNotOrdered`, `TicksNotSpaced` |
| Range is exactly `rangeWidthTicks` wide | `RangeWidthMismatch` |
| Range contains the current market tick | `RangeOffMarket` |
| Range is closer to the market by at least `minImprovementBps` | `NotEnoughImprovement` |
| Cooldown elapsed since the last action | `CooldownNotElapsed` |
| Measured liquidity within `maxLiquidity` | `LiquidityTooLarge` |
| Mandate not expired and not revoked | `MandateExpired`, `MandateInactive` |
| Caller holds `AGENT_ROLE` | `AccessControlUnauthorizedAccount` |

And afterwards, that the position it asked for is the position that exists:
`PositionNotDelivered`, `RangeNotDelivered`.

### The vault builds the payload

`recenter` takes numbers, not router calldata, and assembles the v4 action plan itself:
`DECREASE_LIQUIDITY · BURN_POSITION · MINT_POSITION · TAKE_PAIR`, with the owner as the only
address in it.

An earlier draft accepted validated parameters *and* an opaque `unlockData` blob, and forwarded
the blob. Two disjoint sets, where only the unvalidated one reached the pool — every mandate
check was decorative, and a twelve-agent audit produced ten working exploits against it. The
shape of `recenter` is the fix: there is nothing to forward.

### Why re-centring changes the tokenId

Uniswap v4 has no re-range action. Moving a position is burn-and-mint, and the mint issues a
new `tokenId`. So a mandate is keyed to **the address that committed it**, not to a token that
the authorised action destroys, and the account follows the new id. The cooldown clock, the
expiry, and `revoke` all stay attached to the person.

The mint is funded entirely by the burn. If the proposed liquidity costs more than the
withdrawal credited, the batch is left owing and reverts — which is why the vault never needs
to hold or pay tokens, and why `recenter` is not `payable`.

## Roles

`AGENT_ROLE` proposes actions and can do nothing outside a mandate. `GUARDIAN_ROLE` pauses
actions but cannot block an exit. `UPGRADER_ROLE` schedules and executes upgrades. They are
separate on purpose: a stolen agent key cannot upgrade the contract or trap a user.

## On being upgradeable

An upgradeable contract means the operator *can* change the rules, which sits awkwardly beside
"you do not have to trust us". Three things keep the claim honest:

- **Upgrades wait `UPGRADE_DELAY` (2 days)** after being scheduled, so users can see a change
  coming and leave before it takes effect.
- **The announcement is pinned and finite.** A schedule commits the implementation's `codehash`
  and expires `UPGRADE_GRACE` (7 days) after it becomes ready, so it is a notice period rather
  than a standing authorisation on an address whose code can change.
- **The exit is never gated.** `revoke` is not pausable, not role-gated beyond ownership, and
  unaffected by a pending upgrade. Revoking the NFT approval works without touching this
  contract at all.

This is a real limitation, not a solved problem, and it is described that way wherever the
project is presented.

## Known limitations

Written down rather than glossed over.

- **The agent picks the slippage bounds** on the withdrawal. `amount0Min`/`amount1Min` reach
  the pool unmodified, so a dishonest agent can choose weak ones and let the re-range be
  sandwiched. Bounding them from the mandate is the next thing to tighten.
- **`DEFAULT_ADMIN_ROLE` can grant `AGENT_ROLE` to itself** in one transaction, with no
  timelock. That reaches only what any agent can reach, which is the paragraph at the top of
  this file — but it is admin power, and it should be held by a multisig.
- **The mock is not Uniswap.** `RealisticPositionManager` models authorisation and settlement
  faithfully; it does not model the sqrt-price curve. These tests prove who may act and where
  value lands, not that the liquidity math is right. That needs a fork test.

## Running

```bash
cd contracts
forge build
forge test
```

44 tests. `VaultAttacks.t.sol` holds the audit's findings as regression tests — each one was
written before the contract could pass it, and the commit that added them is red on all nine.
`HelicoVault.t.sol` covers every rejection path above, all three exits (paused, agent removed,
upgrade pending), the upgrade path, and the hash agreement with the CRE workflow.
