# Contributing

Start here. This takes five minutes to read and will save you from the two mistakes that
can disqualify the whole project.

## Before you write any code

### 1. Get confirmed on the ETHGlobal dashboard

**Do this first, before anything else.** Prize money only goes to people who have RSVP'd
and are listed on the team in the ETHGlobal dashboard. If you are not on the team there and
the project wins, you may not be paid your share — regardless of how much you built.

Ask the repo owner to add you, then confirm you can see the project on your own dashboard.

### 2. Read [`CLAUDE.md`](CLAUDE.md)

It is named for the AI agent, but the compliance rules in it apply to humans identically.
The short version is below; the file has the detail.

## Rules

Two kinds, and the difference matters. **ETHGlobal rules** carry a real penalty — up to
disqualifying the whole submission. **Team conventions** are our own choices; we think they
are right, but breaking one costs nothing official.

---

## ETHGlobal rules — breaking these has a penalty

### 1. Commit small and often

Not a style preference. **Judges inspect the commit history.** In the event kickoff:

> *"You cannot just have three commits with a million lines… it has to be properly chunked
> so we can see commits, who did what… following proper branch rules and pull request rules."*

An unauditable repository disqualifies a project from the finalist track. Commit each
coherent step; never squash your working history.

### 2. Write the plan before the code

For anything more than a small fix, write a plan to `docs/plans/<date>-<topic>.md` and
commit it **before** you start building.

This is ETHGlobal's own recommendation, and the plan must state **how the work will be
verified** — because of rule 4.

### 3. Never claim an integration that is not proven to work

An integration that does not genuinely function is a **full disqualification** of the
entire submission. Not a deduction — the whole project.

If you have not tested it, say "untested". If it half-works, say what half. Nobody gets
punished for an honest "not yet"; everyone loses if we claim something false.

### 4. Log your AI usage

Add an entry to [`AI-USAGE.md`](AI-USAGE.md) covering **which files or parts of the code**
were AI-generated or AI-assisted, **which model**, and **what you asked it**.

**Keep your prompts.** ETHGlobal's rules require that spec files, prompts, and planning
artifacts all live in the repository: *"Judges need to see the full picture of how you
directed the AI, not just the generated output."* A plan without the prompt behind it is
half the record.

Using AI is encouraged. Two things are not: not understanding what it produced, and letting
it author the whole project — submissions that rely entirely on AI *"without meaningful
contributions from team members"* can lose partner prize and finalist eligibility.

---

## Team conventions — our choices, not ETHGlobal's

These carry no official penalty. We follow them because they make the work legible.

### Everything in English

READMEs, comments, docs, plans, commit messages.

ETHGlobal does not require this — we checked, there is no language rule. We do it because
judges and partner reviewers read this repository, and Uniswap specifically asks for a
README pointing at particular contracts and lines of code. A document a reviewer cannot
read cannot be credited to us.

### Never rewrite pushed history

Also not an ETHGlobal rule. But they do require history that shows how the work developed
over time, and rewriting it after the fact destroys exactly that. Once real work has
started, treat pushed commits as permanent.

### Conventional Commits

See the format below.

## Commit format

[Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<optional scope>): <short summary, imperative mood>

<optional body: why, not what>
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `build`, `ci`, `perf`.

```
feat(cre): add confidential handler for the risk workflow
fix(contracts): reject zero-address beneficiary on settle
docs: record the Uniswap integration entry points
```

## Branches and pull requests

- **Every change starts as an issue, gets a branch, and lands through a pull request.**
  Nothing goes straight to `main`, however small.
- Branch naming: `<type>/<short-topic>` — e.g. `feat/cre-tee-handler`, the same types as the
  commit convention below.

Judges look for proper branch and pull request practice on the finalist track, so PRs are
worth the small overhead on anything substantial.

## Review

**Every pull request gets the other person as reviewer.** @rifkyeasy requests @ghozzza,
@ghozzza requests @rifkyeasy. [`.github/CODEOWNERS`](.github/CODEOWNERS) does this
automatically, so there is nothing to remember — GitHub skips the author, so each of us is
asked only for the other's work.

**The reviewer merges. The author does not.** @rifkyeasy merges @ghozzza's pull requests;
@ghozzza merges @rifkyeasy's. Requesting a reviewer and then merging the moment CI goes green
is a request, not a review — moving the button makes "somebody else looked" a fact rather than
an intention.

If a reviewer is unreachable and something is genuinely blocking, that goes to Ghoza. It is
not the author's call to skip the review.

Small and obvious changes can still merge as soon as the reviewer has looked; the point is
that someone else looked, not that the process is heavy. Judges on the finalist track expect
proper branch and pull request practice, and a history where authors merge their own work does
not show what we want it to show.

A second pair of eyes is also not a formality here. The review of #70 ran an independent
mutation of the one line the whole forwarder path rests on. The review of #67 found five
claims on the landing page that were not true. Neither would have come from a green tick.

## Where things live

| Directory | Contents |
|---|---|
| [`contracts/`](contracts/) | Smart contracts |
| [`apps/cre/`](apps/cre/) | Chainlink CRE workflows — see its README for the mandatory `handlerInTee` requirement |
| [`apps/be/`](apps/be/) | Backend |
| [`apps/landing/`](apps/landing/) | Landing page, Astro |
| [`packages/core/`](packages/core/) | Shared library, `@helico/core` |
| [`packages/plugins/`](packages/plugins/) | **Every partner integration**, one package each, `@helico/plugin-<name>` — see [its README](packages/plugins/README.md) |
| [`docs/plans/`](docs/plans/) | Implementation plans, written before the code |

## What must not be committed

This repository is **public** and must stay public through judging. Anyone can read it.

Never commit:

- Credentials, API keys, `.env` files, private keys, seed phrases
- Personal identifiers — email addresses, phone numbers
- Competitive strategy — which prizes we are targeting and why, odds, competitor analysis

Implementation plans belong here. Contest calculus does not. If a note would help someone
else compete against us, it does not go in this repository.

> ⚠️ A committed secret is compromised even after you delete it — the value stays in the
> git history and in anything that already cloned or mirrored the repo. If it happens, say
> so immediately and rotate the key. Do not quietly remove it.

## Before you open a pull request

- [ ] Commits are small, and their messages explain the change
- [ ] Everything you wrote is in English
- [ ] A plan exists in `docs/plans/` if this was a significant change
- [ ] `AI-USAGE.md` updated if you used AI
- [ ] Anything you claim works has actually been run
- [ ] No secrets, no personal data

## Stuck?

Ask in the team channel rather than guessing. Under a deadline, an hour of someone else's
context beats a day of your own archaeology.
