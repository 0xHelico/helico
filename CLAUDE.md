# CLAUDE.md — Helico

Working guide for Claude Code in this repository.

## What this is

An **ETHOnline 2026** hackathon submission. Monorepo: `contracts/` for Solidity, `apps/` for
runnable services (`apps/cre/`, `apps/be/`), `packages/plugins/` for partner integrations.

**Every partner integration that is off-chain code goes in `packages/plugins/<name>` as
`@helico/plugin-<name>`** — apps consume them, apps never talk to a protocol directly. This is
not only tidiness: the Uniswap bounty rewards tooling built for the broader ecosystem, and the
partner prizes require a README pointing at the exact lines proving the integration, which
stays far easier when each partner owns one package.

**On-chain integrations are the exception, and live in `contracts/`.** `HelicoMandateSwap` is
an 1inch Aqua app, so it is a Solidity contract that inherits `AquaApp` — there is no package
to put it in, and wrapping it in one would add a layer that proves nothing. The rule is about
where protocol knowledge lives, not about the directory: `contracts/` owns what is deployed,
`packages/plugins/` owns what talks to what is deployed.

A user's own account contract lives there too — see the next section for why it is per-owner
rather than shared, and for the invariants that must hold whatever is built on top of it.

The rules below come from ETHGlobal's official workshops and the event prize page, not
from guesswork. The research notes behind them are kept outside this repository.

## Contract architecture, and the invariants that must survive any change

Decided 8 September, written down because two of these are one-way doors.

**One account per owner.** A user's tokens live in a contract that is theirs, not in a shared
one. That contract is the *maker* in Aqua's ledger, it holds its own lending receipts, and it
unwinds its own position inside a swap. The shared-contract version is in git history; the
reason it went is that pulling a maker's Aave position requires holding their receipt token,
and there is no withdraw-on-behalf-of in Aave — so a shared contract would have needed an
unlimited approval from every user, and one bug would have reached all of them at once.

**The escape hatch is not upgradeable.** The owner may withdraw everything to themselves
through a function that lives in the proxy, outside any implementation. Code may be replaced
entirely; that path may not. This exists because the owner chose to let CRE upgrade accounts
automatically, and that choice is only survivable if there is one door nobody can wall up.

**The agent's reach is the owner's allowlist, and the allowlist only binds outbound moves.**
What makes a compromised agent harmless is that every address it can make this account touch is
one the owner permitted: `withdrawIdle` sends to `address(this)` and never to `msg.sender`,
`setAgent` and `permitVenue` are owner-only, `_authorizeUpgrade` goes through `UPGRADER`, and
each `forceApprove` is closed in the same call. The convenience change that destroys this is
giving `withdrawIdle` a recipient parameter; the second one is dropping its venue check outright,
which would let a compromised agent make this account call any address at all with that selector.

**The check on the way out is the wider set, not the same one.** `supplyIdle` is gated on
`permittedVenue`; `withdrawIdle` on `venueEverPermitted`, which is set on permit and never
cleared. Revoking a venue closes the way in and leaves the way out open, so the agent unwinds a
revoked position on its next run instead of holding beside money the owner said they wanted out
of. The bound is unchanged in the way that matters: every address the agent can make this account
touch is one the owner named. The owner is exempt from even that, because `execute` already
reaches everything.

**Aqua's ledger is the only way this code moves someone's tokens.** Never take an ERC-20
approval to a Helico contract for a user's assets — not for a token, and especially not for a
lending receipt. An approval outlives the mandate, ignores `maxOut`, and survives `dock`. The
ledger does none of those things: it is a number the owner shipped, it falls as it is spent,
and docking destroys it. `ForkAquaHoldsATokens.t.sol` is the proof and should stay green.

**The wallet is spent before any lending market.** A swap that does not need the yield layer
must never be able to fail because of it.

**An app's reach is the ship, and `msg.sender` is what makes that true.** Aqua indexes balances
by the caller, not by an address the caller supplies:

```solidity
function pull(address maker, bytes32 strategyHash, address token, uint256 amount, address to) external {
    Balance storage balance = _balances[maker][msg.sender][strategyHash][token];
    balance.store(prevBalance - amount.toUint248(), tokensCount);
    IERC20(token).safeTransferFrom(maker, to, amount);
}
```

So a contract cannot claim to be another app, and nothing it does reaches a maker who did not
ship to *its* address, under *that* hash. That is what makes deploying our own SwapVM router a
boring sentence rather than an alarming one: a redeployed router is not a door into anybody
else's position, and it is Aqua's property rather than our promise.

Read the bound exactly, though. Within what a maker shipped to it, an app has **full
discretion** — `to` is a parameter, so it may send pulled tokens anywhere, and there is no
active-strategy check: the subtraction underflowing is the only thing that stops an over-pull.
Shipping to an app is trusting that app with those amounts, and the ship is the whole of the
trust. Aqua validates nothing about the app it is handed — no registry, no allowlist, no code
check — which is why `ship` to the wrong address succeeds silently and
`ForkSwapVMYieldCover.t.sol` measures what that costs rather than arguing about it.

**Refusals are named, and the quote refuses what the swap refuses.** A lending market's own
limits surface as arithmetic panics from inside it; a caller cannot read those. And a quote
that answers for a swap that would revert sends an agent to build a transaction that cannot
land — this contract's own docblock says so, so violating it is self-contradiction rather than
a style question.

**A maker with debt is refused, not attempted** — at the venue the swap actually draws on.
A lending market blocks a borrower from withdrawing collateral, so one ordinary borrow would
otherwise disable a mandate, and the failure would arrive as the market's error after the
mandate looked fine. A borrowing maker can also be liquidated out of the position the mandate
depends on. Read the debt from the venue being unwound: a market reports a position aggregated
across its own reserves, never across other markets.

**A venue is validated against the pool, never against itself.** A receipt token is an address
the maker writes into their mandate, so anything it says about itself is something the maker
could have made up — `POOL()` on a forged receipt simply returns the real pool. Ask the pool
which receipt it issues (`getReserveAToken`). Without it, `withdraw` burns the receipt the
*pool* recognises while every guard in `_cover` measures the one the *mandate* named, and the
two need not be the same token.

**A venue that cannot pay is skipped, not fatal.** Market liquidity is one of three conditions;
the maker's position there and the mandate's remaining receipt budget are the other two.
Checking only the first ends the search at a venue that cannot pay and strands a funded one
further down the list.

**Evidence has to be unsatisfiable if the thing is false.** Three times on 8 September a check
passed that could not have failed: a NatSpec claim that the canonical Aqua carried no events,
asserted without ever running `eth_getLogs`; a `subgraph.yaml` comment saying the same, which would
have started the index 17 million blocks late and looked like an empty subgraph rather than a wrong
one; and a test proving an account could hold ETH using `vm.deal`, which sets a balance without
ever performing a transfer — the account could not in fact receive one. Before trusting a check,
ask what it would look like if the claim were false. If the answer is "the same", it is not a check.
Two people asserting the same unmeasured thing is not corroboration either.

Each of these has a test in `contracts/test/MandateVenueUnwind.t.sol`, and each of them failed
before that file existed. An invariant stated only in a comment is a wish: every one of these
was written down in NatSpec before it was true in code, and the code contradicted all of them.

## Language — team convention, not an ETHGlobal rule

| Where | Language |
|---|---|
| **Everything committed here** — docs, comments, READMEs, plans | **English** |
| Commit messages, PR titles and bodies | **English** |

ETHGlobal imposes no language requirement — the workshops and prize page say nothing about
it. This is our own convention, adopted because judges and partner reviewers read this
repository, and Uniswap asks for a README pointing at particular contracts and lines of
code. A document a reviewer cannot read cannot be credited.

## Commit convention

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<optional scope>): <short summary in the imperative>

<optional body explaining why, not what>
```

Types in use: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `build`, `ci`, `perf`.

Examples:

```
feat(cre): add confidential handler for the risk workflow
fix(contracts): reject zero-address beneficiary on settle
docs: record the Uniswap integration entry points
```

## Finishing a piece of work

Work starts from an issue and lands through a pull request. Three things then happen, and none
of them waits to be asked:

**Close the issue.** When the work it describes is done and merged, close it — with a comment
saying what settled it, not just the PR number. An issue left open after its work landed makes
the list a record of what was once true, and the next person reading it plans around a problem
that no longer exists.

**Move it on the board.** [Helico Team](https://github.com/orgs/0xHelico/projects/1), and the
status field means what it says: `Ready` when nothing blocks it, `In progress` when someone is
actually on it, `In review` for an open pull request, `Blocked` when it is waiting on somebody,
`Done` on merge. Items are added automatically; the status is not, so everything sits in
`Backlog` and the board says nothing until someone moves it.

**Label it, on both issues and pull requests.** One area label at minimum, so the list can be
filtered by where the work is:

| | |
|---|---|
| `contracts` | `contracts/` — the Aqua app, the accounts, the SwapVM instruction |
| `app` | `apps/app`, the dapp |
| `landing` | `apps/landing`, the marketing page |
| `be` | `apps/be`, the Go backend |
| `cre` | `packages/plugins/cre` and the CRE workflow |
| `thegraph` | `subgraph/` and `packages/plugins/thegraph` |
| `1inch` | Aqua, SwapVM, `packages/plugins/1inch` |
| `submission` | the ETHGlobal deadline, dashboard, video, prize rules |

More than one is fine and often right — a change to the account contracts that the workflow
reads is `contracts` and `cre`. `uniswap` still exists for history; it is not a submitted track.

## ETHOnline 2026 compliance

The rules below carry disqualification consequences. They are not style preferences.

### Deadline

**Submit by Sunday, September 13, 2026, 12:00 ET.**
Failing to submit forfeits both prize eligibility **and** the entry stake. Submissions can
be updated until the deadline — submit early, refine afterwards.

### How to commit — this is a judging criterion

- **Small, frequent commits with messages that explain the change.** Judges inspect commit
  history. *"You cannot just have three commits with a million lines"* disqualifies a
  project from the finalist track.
- **Never squash** working history into one large commit.
- **Never rewrite published history** once real work has started. *(Team convention — not
  an ETHGlobal rule, but rewriting destroys the development history they do require.)*
- **Every change starts as an issue, gets a branch named `<type>/<short-topic>`, and lands
  through a pull request.** Never commit straight to `main`.
- The repository **must stay public** for the duration of the event and judging.
- These rules apply to **every** repository connected to the submission, not just the primary.

### AI usage

Permitted and encouraged. What is forbidden is **not understanding the result**.

- **Commit plans to the repository.** Before any significant implementation, write the plan
  to `docs/plans/<date>-<topic>.md` and commit it **before** writing code.
- **Keep the prompts too.** ETHGlobal's rules state that if you use a spec-driven workflow,
  you *"must include all spec files, prompts, and planning artifacts in your submission
  repository. Judges need to see the full picture of how you directed the AI, not just the
  generated output."* Plans alone do not satisfy this — record the actual prompts alongside
  them.
- **Log it in `AI-USAGE.md`** — which parts of the code, which specific files or assets were
  AI-generated or AI-assisted, which model, and what the instructions were.
- **AI assists, it does not author.** Submissions that *"rely entirely on AI without
  meaningful contributions from team members may not be eligible for partner prizes or
  finalist consideration."*
- **Never claim an integration that is not proven to work.** A fake integration is a
  **full disqualification**, not a deduction. If it is untested, write "untested".

### Hard prohibitions

1. **Speeding up the demo video** → automatic disqualification
2. **A partner integration that does not genuinely work** → full disqualification
3. **Failing to submit** before the deadline → forfeits prizes and stake
4. **Misrepresenting what was built** → prizes withdrawn and a ban

### Pre-submission checklist

- [ ] Repository public, code open source
- [ ] README describes the project and **points to the contracts and lines of code** behind
      each integration
- [ ] `AI-USAGE.md` filled in honestly
- [ ] Commit history clean and traceable
- [ ] Demo video passes every rejection criterion (see below)
- [ ] Every partner integration **tested and genuinely working**
- [ ] At most **3 partner prizes**, each confirmed open to our track
- [ ] For the finalist track: **deployed and usable by others without us running anything**
      (localhost is not accepted; testnet is fine)

### Demo video — automatic rejections

Upload fails or a re-submission is demanded for any of these:

| 🚨 Never | Consequence |
|---|---|
| Under 2 minutes or over 4 minutes | **Upload fails** |
| Below 720p | **Upload fails** |
| Sped up to fit the time limit | Re-submission demanded |
| Music with on-screen text instead of you speaking | Re-submission demanded |
| Recorded on a mobile phone | Re-submission demanded |
| Text-to-speech or AI voiceover | Re-submission demanded |

Editing to cut out waiting is allowed. Keep the intro under 20 seconds, and if you use
slides, no more than four bullet points each.

### Partner prizes

Up to **3** per submission. Note: **if one partner has several tracks, qualifying for all of
them still counts as a single partner prize** — so picking a partner with multiple prizes
costs one slot, not several.

### Partner requirements

> **The three tracks are Chainlink, 1inch and The Graph** (decided 7 September, #125).
> **Uniswap is not one of them.** `FEEDBACK.md` stays in the repository and the v4 code stays
> tested, but the Uniswap Developer Feedback Form is no longer a submission requirement — #16 is
> closed for that reason. Do not re-add it to a checklist without the track coming back first.

**Chainlink:**
- [x] The workflow registers and uses **`handlerInTee`** (TypeScript) or **`cre.HandlerInTee`** —
      `packages/plugins/cre/src/index.ts`, `initWorkflow`
- [x] The Confidential Workflow performs a **meaningful part** of the application, not a token gesture —
      it makes the only decision the product has, and since 11 September the DON writes it to the chain

**1inch:**
- [x] The Aqua app is custom, not a fork of `XYCSwap` — ours replaces the strategy struct with a
      mandate and adds refusals the example has none of. Merged in #148
- [ ] **"a sophisticated DeFi position"** — open, and the partner's answer leans against. The
      *app* is custom; the *position* it implements is constant product, the same one the
      example implements. See the warning below
- [x] README points at the contract and what it enforces

**The Graph:**
- [ ] **Two or more Graph products combined**, *or* meaningful work on a standardised schema
      (they name Messari Standardized Subgraphs). Planned: a subgraph of our own plus the
      Subgraph MCP server
- [ ] **Live data consumed from a Graph provider** — Subgraph Studio for subgraphs, The Graph
      Market for Substreams. A mocked dataset does not qualify
- [ ] The Graph is **load-bearing**, not decorative. Ours is: Aqua's balances mapping is private
      and four levels deep and no event parameter is `indexed`, so "which mandates does this
      maker have?" has no on-chain answer at all
- [ ] Demo video, 2–4 minutes, and open source with a clear README

> ⚠️ Two Graph tracks exist and **both cost one slot**, because a sponsor with several tracks
> still counts once: *Best AI Tooling or AI Use Case* and *Best Use of Composable or Standardized
> Graph Products*. Qualifying for one does not automatically qualify for the other — the tracks
> are binary.

> ⚠️ **The Aqua scope question was answered on 7 September, and the answer is not "yes".** The
> prize text reads *"Create a custom Aqua app that implements a sophisticated DeFi position"*.
> Asked in `#partner-1inch` whether an app whose novelty is **policy** rather than **price
> discovery** satisfies that, the answer was:
>
> > *"Aqua app with swaps respect maker signed limits sounds quite general. Good luck in building
> > what you feel interesting on Aqua"*
>
> That is not a refusal and not an endorsement. It declines to bless the design and calls it
> general, which is the reading to work from. **Do not write a checklist line claiming this
> qualifies.**
>
> The evidence agrees with them, and it is checkable rather than a matter of taste.
> `@1inch/swap-vm-sdk@0.4.1` ships these position primitives:
>
> ```
> concentrate    dutch-auction   twap-swap    pegged-swap
> oracle-price-adjuster          limit-swap   decay
> xyc-swap       fee   min-rate  base-fee-adjuster  invalidators  controls
> ```
>
> plus `XYCConcentrate.sol` and its `computeLiquidityFromAmounts(availableLt, availableGt,
> sqrtPspot, sqrtPmin, sqrtPmax)`. `HelicoMandateSwap._quote` is `xyc-swap` — the baseline the
> example is named after. So the position our app implements is the example's position; what is
> custom is the mandate around it. That is precisely what "quite general" describes.
>
> **Acted on, 9 September.** `HelicoOracleBoard` was built and it changes what the paragraph above
> describes. `HelicoMandateSwap` prices as a constant product, so the price *is* the ratio of the
> two sides and a maker holding only one token has no price at all — which is the maker this
> product is built for. The board quotes that maker from a Chainlink feed and bends both sides
> **down** as base inventory accumulates, so inventory is pushed home by the price rather than by
> anyone watching. `oracle-price-adjuster` in the list above adjusts a price; it does not know who
> holds what, and the skew is the part no published instruction has.
>
> Six fork tests hold it against the live ETH/USD feed and real USDC, including a stale feed
> refusing the fill and the cap refusing rather than merely discouraging. Four more, added later
> the same day, pay a fill out of the maker's Aave position rather than their wallet.
>
> **A second thing landed on 9 September, and it is about a position rather than a price.**
> `concentrate` — 1inch's own instruction, opcode 18 in the table our router inherits — adds
> virtual reserves so a constant product prices inside a band. Run with `AquaYieldCover` at 34 it
> becomes a concentrated liquidity position whose capital earns in Aave between fills and is
> unwound only when one needs it. Neither half knows about the other: `concentrate` has no idea
> where the inventory is, and the cover has no idea it is quoting a band.
>
> It takes three instructions, `[18][17][34]`, and the two-instruction pairing is impossible
> rather than worse — `concentrate` requires the swap amounts unset, the cover reads the amount
> the swap computed. `ForkSwapVMConcentrateCover.t.sol` measures the working ordering, both
> failing ones, and the band against no band at all: 10,183 USDC paid versus 8,600 from the same
> account on the same trade. One number could not have told a working band from an absent one.
>
> **This still does not say the track qualifies, and no checklist line here claims it.** 1inch
> declined to bless a design and called it general; whether an oracle-priced board with an
> inventory brake, or a band that earns between fills, is less general is their judgement and not
> ours. What changed is that the sentence "the position our app implements is the example's
> position" is no longer true, and this file should not go on saying it.

### Finalist track (optional)

If opted in: attendance at the **Zoom call on Monday, September 14, 12:00–14:00 ET** is
mandatory, seven minutes per team. Missing it disqualifies the project even after passing
round one. Also required: a production deployment (not localhost) and open-source code.

## This repository is public — what belongs here

`helico` has been public since day one and must stay public through judging. Anyone can
read it, including other participants.

| Belongs here | Does not |
|---|---|
| **Implementation** plans — what is being built, how, and how it will be verified | **Strategy** — which partners to target and why, odds of winning, competitor analysis |
| Partner requirements that are already public | Internal research notes and their sources |
| Technical obstacles and how they were solved | Personal identifiers — email, phone, accounts beyond what this repo needs |
| Architectural decisions and their rationale | Credentials, API keys, any `.env` |

The distinction is subtle but real: ETHGlobal **asks** for plans to be committed, and what
they mean is **implementation** plans — evidence that thinking preceded code. That belongs
here. Contest calculus does not.

When unsure which side a note falls on: **if it would help someone else compete against
you, it does not belong in this repository.**

## Git

- Verify `git config user.email` is correct before committing.
