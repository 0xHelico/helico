# Contracts

Three contracts ship, and one idea sits behind all of them: a user commits to rules, and an agent
may act only inside them.

- **`HelicoAccount`**, with `HelicoAccountProxy` and `HelicoAccountFactory` — one account per
  owner, holding that owner's capital. The agent may only move it between lending markets the
  owner permitted, and neither call it can make takes a recipient.
- **`HelicoMandateSwap`** — an Aqua app: a mandate on an agent that swaps against a maker's own
  wallet, through [1inch Aqua](https://github.com/1inch/aqua).
- **`HelicoAquaSwapVMRouter`**, in [`src/swapvm/`](src/swapvm/) — a 1inch SwapVM instruction that
  settles a swap out of capital still earning in a lending market.

A fourth, **`HelicoOracleBoard`**, is written and tested but **not deployed**. See below.

## HelicoOracleBoard

Built 9 September, **not deployed**. A second Aqua app, sitting beside `HelicoMandateSwap` rather
than replacing it, and it exists because of a maker the first one cannot serve.

That maker holds **one** token. Their USDC sits in a lending market earning, and a fill is settled
out of it mid-swap by the SwapVM instruction. `HelicoMandateSwap` refuses to quote them, and is
right to: its price *is* the ratio of two balances, so a zero side has no price at all.

|  | quotes a one-sided maker | brakes itself | settles out of a lending position |
|---|---|---|---|
| `HelicoMandateSwap` — constant product | no | yes, for free | yes |
| a fixed price — `test/FixedPriceBoard.sol` | yes | no | no |
| `HelicoOracleBoard` | yes | yes | yes |

The last column was empty here for a day, and the gap mattered more than it looks: the maker this
app exists for is exactly the one whose capital is **not** in their wallet. Without the unwind the
board quotes a price nobody can be paid. `_cover` is now here too — the same one
`HelicoMandateSwap` carries rather than a second version of it — so the wallet is spent first,
only the shortfall is unwound, and the receipt is pulled through Aqua so the budget stays a number
the maker shipped and `dock` destroys.

Measured on a fork, the maker holding a 500 USDC float with everything else supplied to Aave v3:

```
loose before      500 USDC
supplied before   29,500
paid to taker     2,493        larger than the wallet held
supplied after    27,507       the position paid the difference
loose after       0
```

The price comes from Chainlink; the brake comes from Aqua's own ledger:

```
bid = mid * (BPS - spread - skew) / BPS      the maker buying base
ask = mid * (BPS + spread - skew) / BPS      the maker selling base
```

Both sides shift **down** as base inventory accumulates, so selling into the board gets steadily
worse while buying the inventory back gets steadily better. Inventory is pushed home by the price
rather than by anyone watching — which is what a constant product gets for free, restored on top
of a feed that knows nothing about who holds what.

Measured against the live ETH/USD feed on Arbitrum One
([`0x639Fe6ab…ba612`](https://arbiscan.io/address/0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612),
`"ETH / USD"`, 8 decimals — read from the chain rather than assumed):

```
chainlink ETH/USD  2483.504394
bid                2476.053880    empty inventory, the feed less 0.30%
ask                2490.954907
bid, half full     2451.218836    bent by half the skew
```

### Three guards, and each is the difference between a board and a gift

- **Staleness.** A board quoting yesterday's price is a board being taken from. The feed's
  `updatedAt` must be within `maxStaleness` or the fill is refused.
- **A hard cap.** Skew bends the price but never refuses, and a bad price is still one somebody
  takes once the market has moved far enough. `baseCap` is the refusal.
- **A spread.** It is the only thing the maker earns here. Quote exactly at the feed and every
  fill is somebody who knows the market moved before the feed did.

What it does **not** do: it has no view on whether the feed is right. A feed manipulated inside
its heartbeat is a loss here exactly as it is for anything else quoting from one, and the spread
is the only cushion.

### Two guards that came with the unwind

- **A maker with debt is refused.** Unwinding collateral can liquidate them, and Aave's own health
  checks do not run for us, so the refusal has to be ours.
- **A receipt that aliases a traded token is refused** at check time, because the unwind would
  spend the very reserve it is topping up — taking the ledger down twice for one fill.

### One thing a one-sided maker has to do that is easy to miss

**Approve the token you do not hold yet.** The moment you acquire any base, you may be asked to
sell it — and an approval covering only what you hold means you can buy and never sell. The fork
test found this the hard way, as a `SafeTransferFromFailed` on the second fill.

## The vault, and why it is gone

`HelicoVault` enforced a mandate on an agent re-centring a Uniswap v4 position, and most of this
file used to describe it. It was deleted on 8 September 2026: it was never deployed, CRE had moved
to the yield layer, and the Uniswap v4 work was never a submitted track.

Two things it documented still apply to what ships, so they moved rather than went:

- **A payable batcher lets one `msg.value` be spent by every call in the batch.** The guard is
  [`scripts/check-no-payable.py`](../scripts/check-no-payable.py), now reading `HelicoAccount`'s
  ABI. A Solidity test cannot hold this line — it can only show that today's batcher rejects
  value, which stays true however the contract changes around it.
- **A test that inherits the layout it checks proves nothing about the layout.** The vault's only
  upgrade-test target was a `V2` that inherited from it, so a shifted slot was invisible to every
  test in the suite. [`scripts/check-storage-layout.py`](../scripts/check-storage-layout.py) reads
  the compiler's output instead.

The code itself is in the history, and the plans that produced it are in
[`docs/plans/`](../docs/plans/) where they were written.

## HelicoMandateSwap

An Aqua app. The maker's tokens never move into it, or into Aqua: `ship` transfers nothing,
`pull` sends the maker's tokens straight to the recipient, and `push` sends the taker's straight
to the maker. Aqua keeps a ledger saying how much of the maker's wallet an app may spend, and
nothing more. A test asserts that both Aqua and the app hold zero before and after a swap.

What this app adds is the mandate:

```solidity
struct SwapMandate {
    address maker;
    address token0;
    address token1;
    uint256 feeBps;
    uint256 maxOut0;   // per-swap ceiling on token0 leaving the maker
    uint256 maxOut1;   // per-swap ceiling on token1 leaving the maker
    uint64  expiry;    // first dead second; a swap AT expiry is refused
    address agent;     // zero means open to anyone
    bytes32 salt;
}
```

**Aqua never reads these bytes.** It files a strategy under `keccak256` of whatever the maker
shipped and hands the app a ledger keyed by that hash. Every field above is therefore enforced
here or nowhere — and a field nobody reads would be worse than a missing one, because it reads
as a promise and behaves as decoration.

That also means tampering is not a threat worth a check: change any field and the hash changes,
so the swap lands on a strategy Aqua has never seen and `safeBalances` refuses it. One test
covers all of them, rather than restating one protocol fact once per field.

### The ceiling is on the way out, per token

Both halves of that were arrived at by being wrong first.

An **input** ceiling bounds the output only through the curve, and the curve can be made to pay
out everything. Aqua's `ship` validates nothing, so a strategy shipped with a zero amount on one
side is active, and constant product then returns the *entire* opposite reserve for two wei of
input. `DegenerateReserves` refuses that swap — but the limit a maker actually means is still
"never hand over more than this", which is a limit on the output.

A **single** ceiling cannot mean anything across a pair, because either token can be the input.
`1000e6` is 1000 USDC one way and 10^-12 WETH the other.

### The agent is a contract, and rotating it is expensive

solc emits an `EXTCODESIZE` check before a high-level call to a function with no return value,
so the taker callback can only land on a contract. A plain EOA reverts with or without a gate.
`agent` therefore names an executor contract, not a signing key.

Rotating it costs a `dock` and a re-ship under a new salt, because Aqua freezes a strategy for
the lifetime of its hash and docking burns that hash permanently. If the agent key leaks, the
response is one `dock` transaction — which is enough, and is not the same as being able to swap
the key out. An EIP-712 signature from the agent would fix that properly, with the key outside
the strategy; it is not built.

### Exact-in only

The ceiling belongs on a number the taker does not name. Under exact-in the output comes from
the curve; under exact-out the taker names it. Exact-out can be added deliberately later rather
than arriving as a symmetry nobody asked for.

### Believing the tests

28 tests run against a real `Aqua` deployed in `setUp`, and 7 more in
`MandateVenueUnwind.t.sol` cover the unwind path. Nothing mocks Aqua or the app, because Aqua
holds no tokens and needs no other protocol, so a local deployment *is* the real thing.

Every guard on the swap path was removed, one at a time, and the suite re-run. All 11 mutations
are caught.

The unwind path was added later and its guards were checked the same way, but the one worth
recording is the pool-to-receipt binding. Removing it does not merely turn a test red — the swap
**succeeds**, and 90.66 of another party's receipt tokens leave the contract. A test that passes
with a fix already in place has not been shown to catch anything; that number is what showed it.
The reentrancy one needed care: deleting the modifier makes `_safeCheckAquaPush` revert with
`MissingNonReentrantModifier`, so every test fails and none of them say anything about the
attack. Removing the guard **and** inlining the same balance check leaves a contract that looks
correct, and then exactly one test fails — because two overlapping swaps snapshot the same
balance and a single payment satisfies both checks.

Negative tests use funded, approved callback contracts, so deleting the rule under test would
let the swap *succeed*. The agent test has a control: the same contract that is refused
succeeds once a mandate names it.

## HelicoAccount, HelicoAccountProxy, HelicoAccountFactory

One contract per owner, so a bug in the code that holds one person's money cannot reach anyone
else's. The factory computes the address with `CREATE2` before anything is deployed, which means
an owner can be paid before they have ever sent a transaction, and `open` is idempotent and
permissionless — opening someone's account grants nothing, because the owner is fixed by the
address itself.

### The escape hatch lives in the proxy, and that is the whole design

A proxy forwards everything to its implementation. Put "send everything back to the owner" in the
implementation, and the same key that replaces the implementation can delete the way out. An exit
that can be revoked is not an exit.

So `escape` is the proxy's own function and `OWNER` is an `immutable` — in bytecode rather than
storage, where no implementation can write it and no layout can shift it.

**What that costs, written here rather than left to be discovered.** Two selectors belong to the
proxy and never reach the implementation: `escape(address[])` and `OWNER()`. An implementation
must not declare them.

`test_AnUpgradeCannotTakeTheAccountOrDeleteTheWayOut` installs an implementation that declares
both and answers them in an attacker's favour. Ownership does not move and the owner still
withdraws everything.

The implementation address lives in each proxy's own ERC-1967 slot rather than a shared beacon. A
beacon is cheaper — one write changes everyone's code — and that is exactly the shared fate this
architecture exists to avoid.

### The account stores no owner

It reads the proxy's immutable. One source of truth, in the half that cannot be upgraded, so no
version of the replaceable half can disagree with the escape hatch about who the owner is. That
also removes the initializer: during the proxy's constructor its own code is not yet deployed, so
a callback to read `OWNER` would revert, and an owner passed as an argument would create a second
place for the answer to live.

### What the agent may do, and why the shape is the guarantee

`supplyIdle(pool, asset, amount)` and `withdrawIdle(pool, asset, amount)` move the account's
assets between the account and a lending market the **owner** allowlisted. **There is no recipient
parameter in either signature.** An agent holding this authority can decide where money works, and
has no interface through which to send it anywhere else. That is a property of the shape rather
than a rule anyone is trusted to follow.

The allowlist is the owner's alone. Deciding where money works was delegated; deciding what counts
as a market was not, because a contract that merely behaves like a lending pool is how an
allowlist gets drained.

The approval `supplyIdle` grants is for exactly `amount` and is taken back in the same call — an
allowance outlives the nomination that justified it, and revoking an agent has to revoke
something.

Eleven of the account's tests are the negative space: the agent cannot make a general call, cannot
use the escape hatch, cannot upgrade, cannot nominate another agent, and cannot introduce its own
venue.

### Signed execution, so a first-time user signs once and sends nothing

`executeWithSignature` lets the owner authorise one call and anyone carry it, which is what makes
the first-time flow a single step: a relayer opens the account and runs the owner's first command
in the same transaction.

EIP-712 written out rather than inherited, because `EIP712Upgradeable` keeps its name and version
in storage and needs an initializer this contract deliberately does not have. The domain binds
`address(this)` — the owner's own proxy — and `block.chainid`, and there are tests for a signature
travelling to the owner's *other* account and to another chain.

The nonce is strictly sequential, which is a design choice rather than an implementation detail:
exactly one authorisation is valid at a time, and that is what makes `invalidateSignatures`
correct at `+1`.

The digest lives in `AccountAuth` rather than on the account, because the owner has to be able to
sign **before their account exists** — at signing time there is no contract to ask. The factory
answers for the address the account *will* have, both route through one library so they cannot
drift, and a test asserts the digest signed before deployment is the one verified after.

### Upgrades take effect immediately, and that is deliberate

This contract had an announce-and-wait timelock, as did the vault it was modelled on, and it was
removed on purpose for the hackathon: during a five-day event, being able to fix a mistake in minutes is
worth more than seeing one coming two days out, and a two-day delay would mean a defect found on
the last day cannot be fixed at all.

What it costs: the owner cannot review or refuse a specific upgrade before it lands. What remains
are the two protections that do not depend on timing — `refuseAutoUpgrade`, which removes the
upgrader for good, and the escape hatch, which no implementation can reach.

**Restoring the delay is the first thing to do before this is used with real money.**

Storage layout is covered by `scripts/check-storage-layout.py`, and it matters more here than for
the vault precisely because upgrades are immediate: a shifted `nonce` would make spent signatures
verify again.

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
- **The mandate ceiling is per swap, not a budget.** The reentrancy lock is released when each
  call returns, so a loop inside one transaction multiplies the ceiling freely. A test asserts
  this rather than a comment claiming otherwise. A real budget needs storage keyed per mandate,
  incremented *before* the callback — and sibling mandates of the same maker are reachable from
  inside a callback, so a per-maker counter would be wrong.
- **Fee-on-transfer and rebasing tokens desync Aqua's ledger.** `push` credits the nominal
  amount while the maker receives less, so the ledger overstates the wallet and pulls eventually
  fail. Measured in a test, not assumed. Do not ship such tokens into a mandate.
- **A sufficient ledger is not a promise of settlement.** Tokens are pulled from the maker's own
  wallet, so a maker who moves their balance out breaks their own mandate. The quote still
  answers, because it reads the ledger. 1inch's `SafeERC20` swallows the token's revert reason,
  so every settlement failure looks like `SafeTransferFromFailed()`.
- **The unwind assumes one receipt unit is one underlying unit.** True for a rebasing aToken,
  which is what `ILendingVenue` is shaped for. False for a share-priced receipt — a cToken, or a
  seasoned ERC-4626 share. Below parity the withdrawal reverts; above it the mandate's receipt
  budget drains faster than the position does, and that direction is quiet. Only the owner can
  add a venue, so this is a configuration hazard rather than an attack surface, and it is what
  blocks a non-Aave market being added today.
- **Unwind dust returns to the maker's wallet, not to Aqua's ledger.** The ledger is debited the
  full amount pulled while any remainder goes back to the wallet, so the mandate's receipt budget
  shrinks by slightly more than the position does. Exactly zero for Aave aTokens, where the
  transfer and the burn round identically — it only appears on the venue-agnostic paths the
  interface advertises.
- **`expiry = 0` means permanently dead, not "no expiry".** Because a mandate is immutable and
  docking burns its hash, the typo cannot be repaired in place — only re-issued under a new
  salt.
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

CI leaves `ARBITRUM_RPC_URL` unset, so the fork suite reports `SKIP` there rather than `PASS`.
A green tick for tests that never ran is worth less than an honest gap, so the count CI prints
is smaller than the count with an endpoint, on purpose.

No total is written here. It was wrong three times in one day — corrected, and stale again
within the hour, twice by tests landing between the correction and its merge. The command above
prints the true number, and the landing page derives it from `contracts/test/` at build time
(`apps/landing/src/lib/solidity-tests.ts`). A figure a reader can produce in two seconds does
not need repeating in prose that cannot keep up with it.

The fork tests run against **Arbitrum One** and do **not** pin a block: they fork `latest` and
derive what they need from what they read, so a fixture cannot go stale and a pinned block
cannot quietly stop testing what it claims.

What is in them. `VaultAttacks.t.sol` holds the audit's findings as regression tests — each one was
written before the contract could pass it, and the commit that added them is red on all nine.
The hash agreement with the CRE workflow is pinned to a literal vector that
`packages/plugins/cre` asserts too, generated with `cast` so neither side marks its own homework.

## Deploying

`forge` reads `contracts/.env` on its own — copy `.env.example` and fill it in. The deployer's
key is **not** in that file: every deploy script calls `vm.startBroadcast()` with no argument, so
the signer comes from the command line, and the safe place for it is Foundry's encrypted keystore.

```bash
cast wallet import helico-deployer --interactive   # once; asks for the key, then a password
cast wallet list                                   # confirm

cd contracts
forge script script/DeployAccountFactory.s.sol:DeployAccountFactory \
  --rpc-url "$ARBITRUM_RPC_URL" --account helico-deployer --broadcast
```

Foundry asks for the keystore password each run. The key never reaches `.env`, shell history, or
a process listing — which is worth the extra prompt, because `--private-key` on a command line
puts it in all three.

**Before the first one**, `AGENT_ADDRESS` has to be the enclave's signer, and it is the one value
here you cannot guess: the key behind it exists only inside the Confidential Workflow's TEE. A
wrong address deploys a vault that honours authorisations nobody can produce, and fixing it means
granting `AGENT_ROLE` to the right one afterwards rather than a redeploy — recoverable, but only
if you notice.

`FORWARDER_ADDRESS` can be left unset. The report path is then off, and `setForwarder` turns it on
later without redeploying.

### After it lands

Three files want the address, and nothing reads it from the chain:

| | |
|---|---|
| `apps/cre/workflow/config.production.json` | `vault`, currently the zero address |
| `apps/app` deployment | `NEXT_PUBLIC_VAULT_ADDRESS` |
| `README.md` | wherever the deployment is described |

