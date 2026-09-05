# Implementation plans

Every significant change gets a plan written here **before** the code, then committed.

This is ETHGlobal's own recommendation:

> *"We recommend that you use things in plan mode and actually commit the plans in your
> repo and then continue doing everything."* — Kartik Talwar, ETHOnline 2026 Kickoff

It serves two purposes at once: it forces thinking before an agent is turned loose, and it
leaves a traceable record of process for judges.

## Naming

```
YYYY-MM-DD-short-topic.md
```

## Keep the prompts as well

ETHGlobal's rules on spec-driven workflows require **all spec files, prompts, and planning
artifacts** in the repository, so judges can see how the AI was directed rather than only
what it produced.

Record the prompt that produced a plan inside the plan file itself, under a
`## Prompts` heading. A plan without its prompt is half the record.

## Minimum contents

- **Problem** — what is being solved, and why
- **Approach** — how, and which alternatives were rejected
- **Scope** — what is included, and what is not
- **How to verify** — how we will know it genuinely works

That last section is not a formality. Under the hackathon rules an integration that does
not genuinely work is a **full disqualification**, so a plan without a verification method
is not finished.
