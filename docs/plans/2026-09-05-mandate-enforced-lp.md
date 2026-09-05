# Mandate-enforced LP keep-in-range

Status: proposed · 5 September 2026 · closes #30

## Problem

A user provides liquidity on Uniswap v4 in a chosen price range. When the price leaves that
range the position stops earning fees and sits entirely in one token. Fixing it means
closing the position, swapping to the right ratio, and opening a new one — several
transactions, at a moment the user may not be watching.

Automating that is not new. What is missing from the automated versions is a reason to trust
the automation: the operator's agent decides when and how to move your money, and you find
out afterwards by reading the chain.

Two problems follow from that, and they turn out to be the same problem.

**Trust.** Nothing stops an agent from acting outside what the user asked for. "Our agent
follows your policy" is a claim about software the user cannot inspect.

**Returns.** Rebalancing on every range exit is a known way to lose money — the cost of
closing, swapping and reopening frequently exceeds the fees recovered. The fix is to move
only when the improvement covers the cost, which means the policy needs thresholds, and
thresholds need to be enforced rather than merely intended.

Both are solved by the same mechanism: put the user's policy somewhere the contract can
check it.

## Approach

The user writes what they want in plain language. That is translated **once** into a bounded
struct, and its hash is committed on-chain when the vault is created:

```
Mandate {
  poolId            bytes32     which pool
  rangeWidthBps     uint16      how wide to re-centre
  minImprovementBps uint16      do not act below this expected gain
  cooldownSeconds   uint32      minimum interval between actions
  maxNotional       uint128     ceiling per action
  expiry            uint64      the agent's authority lapses on its own
}
```

The agent proposes actions. The contract **validates every action against the committed
mandate and reverts anything that does not match.** The agent chooses; the contract decides
what is allowed.

Three consequences worth stating plainly:

- **The agent cannot move funds outside the mandate**, so a stolen agent key is a bad day
  rather than a loss of funds. It can re-centre a position within the user's own parameters
  and nothing else.
- **The user can always exit**, without the agent's cooperation and without anyone's
  permission. Nothing the operator controls can block a withdrawal.
- **The thresholds that protect returns are the same rules the contract enforces**, so the
  economics are not a separate promise. `minImprovementBps` and `cooldownSeconds` exist in
  one place and do one job.

### Where the confidential workflow sits

Inside the enclave: the user's thresholds, the reasoning that produced a decision, and any
paid data used to reach it. Crossing out: a verdict and the mandate hash it was checked
against — nothing else.

This is what makes the confidential part load-bearing rather than decorative. The decision
is private; the action is public and checkable. The prize requirement is that the
confidential portion process a sensitive input inside the enclave and contribute to the
application, and thresholds the user does not want visible are exactly that.

> The resulting transactions remain public, as on any chain. What stays private is the
> policy and the reasoning — *when* and *why* we act, not *what* we did. Any wording we
> publish must say it that way.

### Chain

Robinhood Chain mainnet. Uniswap launched there recently and pools are already running
hooks, and the CCA launches aggregator is available there too — it is where the newest
parts of the stack actually run, not merely another deployment target.

CRE cannot write on-chain to Robinhood mainnet, only to its testnet. That costs the
DON-signed report path through the Forwarder; it does not affect prize eligibility, since
the qualification text asks for a confidential workflow and accepts a CLI simulation as
evidence. Mandate enforcement is contract-side and does not depend on who submits the
transaction.

## Scope

**In:**
- Vault contract: mandate commitment, action validation, unconditional exit
- Uniswap v4 keep-in-range via `@helico/plugin-uniswap`
- CRE confidential workflow deciding whether to act, via `@helico/plugin-cre`
- Plain-language mandate translation, shown to the user as the struct before they sign
- Measured returns from our own runs
- A deployed UI others can use without us running anything

**Out:**
- Cross-asset moves and yield hunting across protocols. Same-pool re-centring only — this
  removes swap slippage, MEV exposure and price oracles in one decision.
- Multi-user batching. One user, one vault. Batching is an optimisation for a product that
  has users.
- Borrowing, leverage, upgradeable contracts.

## How to verify

Not a formality — an integration that does not genuinely work disqualifies the whole
submission, so each claim below needs a way to be checked.

| Claim | How it is verified |
|---|---|
| The mandate is enforced, not merely intended | A test that proposes an action violating each field and asserts the revert. Then the same thing on camera. |
| The agent cannot exceed its authority | A test where the agent key signs an action outside the mandate and it fails. |
| The user can always exit | A test that withdraws with the agent stopped and the contract paused. |
| Keep-in-range works | A real transaction on Robinhood Chain: position out of range, action taken, position back in range. Tx hashes in the README. |
| The confidential part is meaningful | `cre workflow simulate` runnable from a clean checkout, with committed output. |
| Returns claims are real | Log every action with expected and realised improvement, and gas spent. Publish the table. If the numbers are unflattering, publish them anyway and say what threshold would have been better. |
| Others can use it | Someone outside the team opens the URL and completes a run with us not present. |

## What we will and will not claim

We will claim the mechanism: positions are kept in range automatically, within limits the
user set and the contract enforces.

We will claim returns **only with our own measurements attached**, and we will state the
threshold and cooldown that produced them. Rebalancing on every exit is a documented way to
underperform; acting only when the improvement covers the cost is the entire point, and the
numbers are what distinguish that from a slogan.

We will not claim that transactions are private, that returns are guaranteed, or that any
integration works before it has run.

## Prompts

The prompt that produced this plan, verbatim, in the language it was given:

> rekomendasimu apa?

Asked in response to a choice between two framings for the same product — an agent that
decides, versus an agent whose compliance can be proven. Preceded by these decisions:
Robinhood Chain mainnet, keep the LP in-range policy, opt into the finalist track,
non-custodial, and — on selling the mechanism rather than the returns:

> iya aku setuju statement ini, tapi tetep di barengin dengan ROI yang baik juga

That second instruction is why this plan commits to measuring returns and publishing the
numbers rather than avoiding the subject.
