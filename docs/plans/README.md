# Implementation plans

Every significant change gets a plan here **before** the code, then committed. ETHGlobal asks for
it directly:

> *"We recommend that you use things in plan mode and actually commit the plans in your repo and
> then continue doing everything."* — Kartik Talwar, ETHOnline 2026 Kickoff

It does two things at once: forces thinking before an agent is turned loose, and leaves judges a
traceable record.

Named `YYYY-MM-DD-short-topic.md`.

## Keep the prompts too

The rules on spec-driven workflows require **all spec files, prompts and planning artifacts** in
the repository, so judges see how the AI was directed rather than only what it produced. Record
the prompt inside the plan file under a `## Prompts` heading. A plan without its prompt is half
the record.

## What a plan needs

- **Problem** — what is being solved, and why
- **Approach** — how, and what was rejected
- **Scope** — what is in, and what is not
- **How to verify** — how we will know it genuinely works

That last one is not a formality. An integration that does not genuinely work is a full
disqualification, so a plan with no way to check it is not finished.
