# Implementation plans

Every significant change gets a plan here **before** the code, then committed. ETHGlobal asks for
it directly:

> *"We recommend that you use things in plan mode and actually commit the plans in your repo and
> then continue doing everything."*. Kartik Talwar, ETHOnline 2026 Kickoff

It does two things at once: forces thinking before an agent is turned loose, and leaves judges a
traceable record.

Named `YYYY-MM-DD-short-topic.md`.

## Keep the prompts too

The rules on spec-driven workflows require **all spec files, prompts and planning artifacts** in
the repository, so judges see how the AI was directed rather than only what it produced. Record
the prompt inside the plan file under a `## Prompts` heading. A plan without its prompt is half
the record.

## How the direction actually arrived, for the 15 that carry no prompt

14 of the 29 plans here quote the prompt that produced them, verbatim and translated where it
was not in English. The other 15 do not, and inventing one after the fact would be worse than the
gap, so here is what is true instead.

**Those 15 were directed from an issue rather than from a written prompt.** The issue was
opened first, it says what the problem is and how it would be checked, and the plan and the code
follow from it. That is the same shape as a spec, written before, committed, reviewable, it
just lives in the tracker rather than in this directory.

| Plan | Written from |
|---|---|
| [`2026-09-05-vault-swap-recentre.md`](2026-09-05-vault-swap-recentre.md) | [#42](https://github.com/0xHelico/helico/issues/42) |
| [`2026-09-06-ai-reasoning-in-the-enclave.md`](2026-09-06-ai-reasoning-in-the-enclave.md) | [#99](https://github.com/0xHelico/helico/issues/99) |
| [`2026-09-06-cre-runnable-project.md`](2026-09-06-cre-runnable-project.md) | [#21](https://github.com/0xHelico/helico/issues/21) |
| [`2026-09-06-mint-what-the-vault-can-afford.md`](2026-09-06-mint-what-the-vault-can-afford.md) | [#78](https://github.com/0xHelico/helico/issues/78) |
| [`2026-09-06-vault-on-report.md`](2026-09-06-vault-on-report.md) | [#37](https://github.com/0xHelico/helico/issues/37) |
| [`2026-09-07-app-dapp.md`](2026-09-07-app-dapp.md) | [#126](https://github.com/0xHelico/helico/issues/126) |
| [`2026-09-07-app-fully-functional.md`](2026-09-07-app-fully-functional.md) | [#126](https://github.com/0xHelico/helico/issues/126) |
| [`2026-09-07-app-sidebar-and-sessions.md`](2026-09-07-app-sidebar-and-sessions.md) | [#126](https://github.com/0xHelico/helico/issues/126) |
| [`2026-09-07-aqua-mandate-swap.md`](2026-09-07-aqua-mandate-swap.md) | [#147](https://github.com/0xHelico/helico/issues/147) |
| [`2026-09-07-idle-liquidity-earns.md`](2026-09-07-idle-liquidity-earns.md) |, |
| [`2026-09-08-account-factory.md`](2026-09-08-account-factory.md) |, |
| [`2026-09-08-app-follows-the-product.md`](2026-09-08-app-follows-the-product.md) | [#175](https://github.com/0xHelico/helico/issues/175) |
| [`2026-09-08-cre-manages-idle-capital.md`](2026-09-08-cre-manages-idle-capital.md) | [#175](https://github.com/0xHelico/helico/issues/175) |
| [`2026-09-08-landing-follows-the-app.md`](2026-09-08-landing-follows-the-app.md) | [#175](https://github.com/0xHelico/helico/issues/175) |
| [`2026-09-08-one-account-per-owner.md`](2026-09-08-one-account-per-owner.md) |, |

The three with no issue were direction given in conversation, in the same session as the work:
the account architecture on 8 September, and the yield layer it replaced. What was said is
recorded in [`AI-USAGE.md`](../../AI-USAGE.md) under the entries for those days, in the user's
own words rather than paraphrased.

**Going forward the rule is the one at the top of this file**: the prompt goes in the plan, under
a `## Prompts` heading, at the time.

## What a plan needs

- **Problem**, what is being solved, and why
- **Approach**, how, and what was rejected
- **Scope**, what is in, and what is not
- **How to verify**, how we will know it genuinely works

That last one is not a formality. An integration that does not genuinely work is a full
disqualification, so a plan with no way to check it is not finished.
