# CLAUDE.md — Helico

Working guide for Claude Code in this repository.

## What this is

An **ETHOnline 2026** hackathon submission. Monorepo: `contracts/` for Solidity, `apps/` for
runnable services (`apps/cre/`, `apps/be/`).

The rules below come from ETHGlobal's official workshops and the event prize page, not
from guesswork. The research notes behind them are kept outside this repository.

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
- Use branches and pull requests for larger changes.
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

**Uniswap Foundation:**
- [ ] A **`FEEDBACK.md`** file in the repository
- [ ] The **Uniswap Developer Feedback Form** submitted, including a link to `FEEDBACK.md`
      → https://developers.uniswap.org/hackathon-feedback
- [ ] README points clearly at the relevant contracts and lines of code

**Chainlink:**
- [ ] The workflow registers and uses **`handlerInTee`** (TypeScript) or **`cre.HandlerInTee`**
- [ ] The Confidential Workflow performs a **meaningful part** of the application, not a token gesture

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
