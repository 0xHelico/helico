# Contracts

`HelicoVault` enforces a user's committed mandate on an agent that re-centres their Uniswap v4
liquidity position.

The user keeps their position NFT and approves the vault to act on it; **revoking that
approval, or calling `revoke`, ends the agent's authority immediately** and cannot be blocked by
the agent, the guardian, or a pending upgrade.

The vault holds nothing **across a transaction**. It is not a custodian and holds no balance
between calls, but tokens do exist in it between the burn and the mint of a single re-centre,
because a swap has to sit there. The contract asserts on chain, at the end of every re-centre,
that it kept none of what passed through.

## What a rogue agent can do

This is the honest version of the security claim, and the one the tests check.

Holding `AGENT_ROLE` lets you re-range a position **whose owner committed a mandate**, into a
band of the committed width, containing the current market price, measurably closer to it than
the band already is, no more often than the cooldown allows, before the mandate expires.

The new NFT and every token that leaves the old position go to the position's owner, because
those are the only destinations the contract will write into a payload. There is no path that
pays an agent, and no path that touches a position whose owner did not commit a mandate.

How much liquidity survives the round trip is capped from below by `minRetainedBps`, so an
agent cannot mint dust and send the remainder to your wallet — leaving you with every token
and no earning position. That check is measured from the liquidity actually delivered, not
from the number the agent asked for.

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
| Delivered liquidity at least `minRetainedBps` of what was withdrawn | `LiquidityNotRetained` |
| Mandate not expired and not revoked | `MandateExpired`, `MandateInactive` |
| Caller holds `AGENT_ROLE`, or an `AGENT_ROLE` holder signed for it | `AccessControlUnauthorizedAccount`, `SignerLacksAgentRole` |

And afterwards, that the position it asked for is the position that exists:
`PositionNotDelivered`, `RangeNotDelivered`.

### The vault builds the payload, and takes the pool lock

`recenter` takes numbers, not router calldata. It calls `poolManager.unlock` and, inside its own
callback, runs `DECREASE_LIQUIDITY · BURN_POSITION · TAKE_PAIR` to withdraw, swaps the excess
side through the position's own pool, then `MINT_POSITION · SETTLE · SETTLE · SWEEP` to mint the
new range to the owner. The owner is the only address written into any of it.

The swap is there because **a position that has drifted out of range holds exactly one token**,
and minting a range that contains the current price needs both. Without it the core case mints
nothing.

**The swap's price limit comes from the committed range.** It is the sqrt price at the edge of
the band the user signed, so the pool itself halts the swap there and the price cannot be pushed
out of that range — not by the agent, not by us. That matters because the range was checked
against the price *before* the swap: without the limit, an agent moves the price afterwards and
mints single-sided while every post-condition still passes. The tick is re-read after the swap
as well, `amountIn` is capped at what the burn actually returned, and `minAmountOut` is a
convenience rather than a guard, because a cap the agent sets is not a cap.

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

### An agent that cannot send transactions

`recenterWithSignature` takes an EIP-712 authorisation instead of requiring the caller to hold
the role. **Anyone may relay it**; the authority is the signature.

That exists so the decision can be made somewhere that cannot hold gas or send a transaction —
a Chainlink CRE enclave — and so `AGENT_ROLE` can be held by a key that exists **only inside
it**, released by the Vault DON and readable by nobody, including us.

The authorisation carries the mandate hash, so one signed against terms the user has since
replaced is refused rather than executed against the new ones. A nonce makes it single use.
Every mandate rule still applies: the signature says *who* authorised an action, never *what*
they were allowed to authorise.

### Batching

`multicall` is inherited, so a relayer holding authorisations for several owners lands them in
one transaction rather than several. A batch is all or nothing, and `delegatecall` preserves the
caller, so a user batching their own calls is still the one making them.

What rules out the usual `Multicall` hazard — one `msg.value` counted by every call in a batch —
is that **`multicall` is not payable**, so there is no value in the batch to count. Not the
absence of payable functions: the vault has one, `upgradeToAndCall` from UUPS.
`scripts/check-no-payable.py` guards the invariant that actually matters, in CI, because a
Solidity test can only show that today's `multicall` rejects value.

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
- **`maxLiquidity` is a cap on the whole position**, not on a slice of it. Re-centring always
  moves everything, so a position above the cap cannot be re-centred at all rather than being
  moved in parts. Set it above the position you intend to manage.
- **A re-centre pays a swap through the position's own pool.** v4 fees are hundredths of a bip,
  so a `fee` of `200000` is 20%, not 20 bps, and pools like that exist. On one of them a
  re-centre can cost more than it recovers. Nothing in the contract can fix it — it is the pool
  the user chose — so the mandate's pool is worth choosing with the fee in mind.
- **Stray native sent to the vault is stuck.** `receive()` accepts from anyone, and a re-centre
  measures only what it produced, so a loose transfer is never paid to somebody else — but
  there is no path to recover it either. That is the trade for not adding a privileged sweep.
- **The mock is not Uniswap.** `RealisticPositionManager` models authorisation and settlement
  faithfully; it does not model the sqrt-price curve, and `MockPoolManager` refuses to model a
  swap at all. Anything asserted about the swap is asserted on a fork or not at all.

## Running

```bash
cd contracts
forge build
forge test

# The fork suite needs an endpoint. Without one it reports SKIP, not PASS.
ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc forge test
```

CI leaves `ARBITRUM_RPC_URL` unset, so the fork suite reports `SKIP` there — read the tick
count as 56 executed, not 62, unless the endpoint is set.

The fork tests run against **Arbitrum One** and do **not** pin a block: they fork `latest` and
derive what they need from what they read, so a fixture cannot go stale and a pinned block
cannot quietly stop testing what it claims.

78 tests, 9 of them on a fork. `VaultAttacks.t.sol` holds the audit's findings as regression tests — each one was
written before the contract could pass it, and the commit that added them is red on all nine.
`HelicoVault.t.sol` covers every rejection path above, all three exits (paused, agent removed,
upgrade pending), the upgrade path, and the hash agreement with the CRE workflow — pinned to a literal
vector that `packages/plugins/cre` asserts too, generated with `cast` so neither side marks
its own homework.
