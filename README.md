# Helico

Submission for [ETHOnline 2026](https://ethglobal.com/events/ethonline2026)
(September 4–16, 2026).

> 🚧 **Work in progress.** The project description, architecture, and integration claims
> get filled in once something actually runs. Nothing here is claimed before it is proven —
> see [Rules](#rules) for why that matters.

## Layout

| Directory | Contents |
|---|---|
| [`contracts/`](contracts/) | Smart contracts |
| [`apps/cre/`](apps/cre/) | Chainlink CRE workflows |
| [`apps/be/`](apps/be/) | Backend |
| [`packages/core/`](packages/core/) | Shared library, `@helico/core` |
| [`packages/plugins/`](packages/plugins/) | Plugins, one package each, `@helico/plugin-<name>` |
| [`docs/plans/`](docs/plans/) | Implementation plans, written before the code |

## Partner integrations

> Filled in only once an integration actually works. The **code reference column is
> required** — some partners verify an integration by reading the exact lines pointed to here.

| Partner | Status | Where | Code reference |
|---|---|---|---|
| — | not started | — | — |

## Contributing

New here? Read [`CONTRIBUTING.md`](CONTRIBUTING.md) first — it is short, and it covers the
two mistakes that can cost the entire submission.

## Rules

This repository follows the ETHOnline 2026 rules. The one that matters most: **an
integration that does not genuinely work is a full disqualification**, not a deduction.

The rules that bind coding sessions live in [`CLAUDE.md`](CLAUDE.md).
AI usage is logged in [`AI-USAGE.md`](AI-USAGE.md).
