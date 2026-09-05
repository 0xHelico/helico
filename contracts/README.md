# Contracts

`HelicoVault` enforces a user's committed mandate on an agent that re-centres their Uniswap v4
liquidity position.

The vault holds nothing. The user keeps their position NFT and approves the vault to act on
it; **revoking that approval, or calling `revoke`, ends the agent's authority immediately** and
cannot be blocked by the agent, the guardian, or a pending upgrade.

## What the contract decides

The agent chooses *whether* and *where* to re-centre. The contract decides what is allowed,
checking every action against the mandate the user committed:

| Check | Rejection |
|---|---|
| Pool key hashes to the committed `poolId` | `PoolNotPermitted` |
| Ticks ordered and aligned to the pool's spacing | `TicksNotOrdered`, `TicksNotSpaced` |
| Range width matches `rangeWidthBps`, snapped to spacing | `RangeWidthMismatch` |
| Cooldown elapsed since the last action | `CooldownNotElapsed` |
| Notional within `maxNotional` | `NotionalTooLarge` |
| Mandate not expired and not revoked | `MandateExpired`, `MandateInactive` |
| Caller holds `AGENT_ROLE` | `AccessControlUnauthorizedAccount` |

It takes **typed parameters, not router calldata**. A non-custodial vault cannot validate
calldata it would have to decode on-chain, so the vault makes the PositionManager call itself.

## Roles

`AGENT_ROLE` proposes actions and can do nothing outside a mandate. `GUARDIAN_ROLE` pauses
actions but cannot block an exit. `UPGRADER_ROLE` schedules and executes upgrades. They are
separate on purpose: a stolen agent key cannot upgrade the contract or trap a user.

## On being upgradeable

An upgradeable contract means the operator *can* change the rules, which sits awkwardly beside
"you do not have to trust us". Two things keep the claim honest:

- **Upgrades wait `UPGRADE_DELAY` (2 days)** after being scheduled, so users can see a change
  coming and leave before it takes effect.
- **The exit is never gated.** `revoke` is not pausable, not role-gated beyond ownership, and
  unaffected by a pending upgrade. Revoking the NFT approval works without touching this
  contract at all.

This is a real limitation, not a solved problem, and it should be described that way anywhere
the project is presented.

## Running

```bash
cd contracts
forge build
forge test
```

20 tests cover every rejection path above, both exits (paused, and with the agent removed), and
the upgrade path — unscheduled, before the delay, cancelled, and by a caller without the role.
