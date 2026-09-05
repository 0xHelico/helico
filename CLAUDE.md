# CLAUDE.md — Helico

Working guide for Claude Code in this repository.

## What this is

An **ETHOnline 2026** hackathon submission. Monorepo: `contracts/`, `cre/`, `be/`.

The rules below come from ETHGlobal's official workshops and the event prize page, not
from guesswork. The research notes behind them are kept outside this repository.

## Language

| Where | Language |
|---|---|
| **Everything committed here** — docs, comments, READMEs, plans | **English** |
| Commit messages, PR titles and bodies | **English** |

Judges and partner reviewers read this repository. Anything they cannot read cannot be
credited.

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
- **Never rewrite published history** once real work has started.
- Use branches and pull requests for larger changes.
- The repository **must stay public** for the duration of the event and judging.
- These rules apply to **every** repository connected to the submission, not just the primary.

### AI usage

Permitted and encouraged. What is forbidden is **not understanding the result**.

- **Commit plans to the repository.** Before any significant implementation, write the plan
  to `docs/plans/<date>-<topic>.md` and commit it **before** writing code. This is
  ETHGlobal's own recommendation and doubles as evidence of process.
- **Log it in `AI-USAGE.md`** — where AI was used, which model, and what the instructions
  were. The submission is required to explain this.
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
- [ ] Demo video **2–4 minutes, ≥720p, clear spoken audio, no music, NOT sped up**
- [ ] Every partner integration **tested and genuinely working**
- [ ] At most **3 partner prizes**, each confirmed open to our track
- [ ] For the finalist track: **deployed and usable by others without us running anything**
      (localhost is not accepted; testnet is fine)

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
