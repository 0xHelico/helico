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

**Aqua's ledger is the only way this code moves someone's tokens.** Never take an ERC-20
approval to a Helico contract for a user's assets — not for a token, and especially not for a
lending receipt. An approval outlives the mandate, ignores `maxOut`, and survives `dock`. The
ledger does none of those things: it is a number the owner shipped, it falls as it is spent,
and docking destroys it. `ForkAquaHoldsATokens.t.sol` is the proof and should stay green.

**The wallet is spent before any lending market.** A swap that does not need the yield layer
must never be able to fail because of it.

**Refusals are named, and the quote refuses what the swap refuses.** A lending market's own
limits surface as arithmetic panics from inside it; a caller cannot read those. And a quote
that answers for a swap that would revert sends an agent to build a transaction that cannot
land — this contract's own docblock says so, so violating it is self-contradiction rather than
a style question.

**A maker with debt is refused, not attempted.** A lending market blocks a borrower from
withdrawing collateral, so one ordinary borrow would otherwise disable a mandate — and the
failure would arrive as the market's error, after the mandate looked fine. A borrowing maker
can also be liquidated out of the position the mandate depends on.

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
- [ ] The workflow registers and uses **`handlerInTee`** (TypeScript) or **`cre.HandlerInTee`**
- [ ] The Confidential Workflow performs a **meaningful part** of the application, not a token gesture

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
> What would answer it is tracked in the Aqua-position issue. Deciding whether to act is
> @ghozzza's call — it is their contract, and it is six days out from the deadline.

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
