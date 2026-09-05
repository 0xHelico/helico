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
| [`apps/landing/`](apps/landing/) | Landing page, Astro |
| [`packages/core/`](packages/core/) | Shared library, `@helico/core` |
| [`packages/plugins/`](packages/plugins/) | Plugins, one package each, `@helico/plugin-<name>` |
| [`docs/plans/`](docs/plans/) | Implementation plans, written before the code |

## Partner integrations

> Filled in only once an integration actually works. The **code reference column is
> required** — some partners verify an integration by reading the exact lines pointed to here.
>
> Uniswap Foundation also requires [`FEEDBACK.md`](FEEDBACK.md), which records what we
> observed while building on their stack.

| Partner | Status | Where | Code reference |
|---|---|---|---|
| Chainlink CRE | reusable package: the enclave recomputes the mandate hash, reads the vault and the pool from inside the TEE, mirrors the vault's range rule, sizes the mint, and delivers `(act, mandateHash, RecenterParams)` to the vault with `writeReport`; unit-tested, decision simulated in the CRE simulator; **delivery not yet run against a deployed vault, not deployed** | [`packages/plugins/cre/`](packages/plugins/cre/) | [`src/index.ts#L137-L172`](packages/plugins/cre/src/index.ts#L137-L172) `onCronTrigger` runs in the enclave, [`src/index.ts#L175-L193`](packages/plugins/cre/src/index.ts#L175-L193) `deliver` writes the report, [`src/index.ts#L196-L204`](packages/plugins/cre/src/index.ts#L196-L204) `initWorkflow` registers it with `handlerInTee` |
| Uniswap v4 | reusable package for any chain: addresses, pools, quotes, swaps (all four shapes), Permit2 approvals, liquidity; quotes and every swap shape verified on Base mainnet by `eth_call`; swaps, approvals, pool initialisation, mint, increase, collect, and burn **executed on Base Sepolia** (transactions in the package README); Robinhood Chain mainnet and testnet resolved and tested offline, on-chain runs pending; **not wired into an app** | [`packages/plugins/uniswap/`](packages/plugins/uniswap/) | [`src/swap.ts`](packages/plugins/uniswap/src/swap.ts) Universal Router `execute`, [`src/quote.ts`](packages/plugins/uniswap/src/quote.ts) v4 `Quoter`, [`src/approval.ts`](packages/plugins/uniswap/src/approval.ts) Permit2, [`src/liquidity.ts`](packages/plugins/uniswap/src/liquidity.ts) `V4PositionManager`, [`src/addresses.ts`](packages/plugins/uniswap/src/addresses.ts) per-chain resolver; line ranges in the package README |

## Contributing

New here? Read [`CONTRIBUTING.md`](CONTRIBUTING.md) first — it is short, and it covers the
two mistakes that can cost the entire submission.

## Rules

This repository follows the ETHOnline 2026 rules. The one that matters most: **an
integration that does not genuinely work is a full disqualification**, not a deduction.

The rules that bind coding sessions live in [`CLAUDE.md`](CLAUDE.md).
AI usage is logged in [`AI-USAGE.md`](AI-USAGE.md).
