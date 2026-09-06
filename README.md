# Helico

Submission for [ETHOnline 2026](https://ethglobal.com/events/ethonline2026)
(September 4–16, 2026).

**Helico keeps a Uniswap v4 liquidity position in range, under rules its owner commits to on
chain.** The owner writes a mandate — which pool, how wide a band, how much may move, how
often, until when. An agent proposes a re-centre; the contract refuses anything the mandate
does not allow. Revoking the NFT approval ends it, and nothing the operator controls can block
that.

Nothing here is claimed before it is proven. Where something is not yet true, it is marked as
not yet true rather than left to be assumed — see [Rules](#rules) for why that matters.

## Layout

| Directory | Contents |
|---|---|
| [`contracts/`](contracts/) | `HelicoVault` and its tests |
| [`packages/plugins/uniswap/`](packages/plugins/uniswap/) | Uniswap v4 on-chain package, `@helico/plugin-uniswap` |
| [`packages/plugins/cre/`](packages/plugins/cre/) | Chainlink CRE confidential workflow, `@helico/plugin-cre` |
| [`packages/core/`](packages/core/) | Shared library, `@helico/core` |
| [`apps/landing/`](apps/landing/) | Landing page, Astro |
| [`docs/plans/`](docs/plans/) | Implementation plans, written before the code |

`apps/be/` and `apps/cre/` are scaffolding from the initial layout and are **empty**. They are
left in place rather than linked as though they held something; the CRE workflow lives in
`packages/plugins/cre`, because every integration is a reusable package here.

## Partner integrations

Every reference below is a **commit-pinned permalink**, verified against the code it points at
rather than copied from an earlier draft — line numbers move, and three of these had already
drifted by the time they were written down.

Uniswap Foundation also asks for [`FEEDBACK.md`](FEEDBACK.md), which records what we ran into
while building on their stack.

### Uniswap v4

The plugin talks to v4 directly — no aggregator, no wrapper — and every claim here has an
on-chain transaction behind it on Base Sepolia, listed in
[`packages/plugins/uniswap/README.md`](packages/plugins/uniswap/README.md).

| What | Where |
|---|---|
| Universal Router `execute`, `V4_SWAP` command, router-level `SWEEP` | [`swap.ts#L100-L121`](https://github.com/0xHelico/helico/blob/e4582449a984340cfede5d6453c81b1a7e0b5154/packages/plugins/uniswap/src/swap.ts#L100-L121) |
| `SWAP_EXACT_IN_SINGLE` action and its settlement pair | [`swap.ts#L148-L170`](https://github.com/0xHelico/helico/blob/e4582449a984340cfede5d6453c81b1a7e0b5154/packages/plugins/uniswap/src/swap.ts#L148-L170) |
| `Quoter` read over `eth_call` | [`quote.ts#L17-L28`](https://github.com/0xHelico/helico/blob/e4582449a984340cfede5d6453c81b1a7e0b5154/packages/plugins/uniswap/src/quote.ts#L17-L28) |
| Pool state through `StateView` | [`pool.ts#L64-L82`](https://github.com/0xHelico/helico/blob/e4582449a984340cfede5d6453c81b1a7e0b5154/packages/plugins/uniswap/src/pool.ts#L64-L82) |
| `PoolId` derivation, matching v4's own | [`pool.ts#L39-L52`](https://github.com/0xHelico/helico/blob/e4582449a984340cfede5d6453c81b1a7e0b5154/packages/plugins/uniswap/src/pool.ts#L39-L52) |
| Addresses resolved from the official SDK | [`addresses.ts#L99-L107`](https://github.com/0xHelico/helico/blob/e4582449a984340cfede5d6453c81b1a7e0b5154/packages/plugins/uniswap/src/addresses.ts#L99-L107) |
| Permit2 approval | [`approval.ts#L93-L110`](https://github.com/0xHelico/helico/blob/e4582449a984340cfede5d6453c81b1a7e0b5154/packages/plugins/uniswap/src/approval.ts#L93-L110) |
| EIP-712 `PermitSingle` typed data | [`approval.ts#L134-L160`](https://github.com/0xHelico/helico/blob/e4582449a984340cfede5d6453c81b1a7e0b5154/packages/plugins/uniswap/src/approval.ts#L134-L160) |
| `PositionManager` mint | [`liquidity.ts#L93-L124`](https://github.com/0xHelico/helico/blob/e4582449a984340cfede5d6453c81b1a7e0b5154/packages/plugins/uniswap/src/liquidity.ts#L93-L124) |

### The vault

`HelicoVault` enforces a user's committed mandate on the agent that re-centres their position.
It is upgradeable behind a timelock, non-custodial, and every rejection path is a test — see
[`contracts/README.md`](contracts/README.md) for what a rogue agent can and cannot do.

| What | Where |
|---|---|
| The mandate a user commits | [`Mandate.sol#L20-L62`](https://github.com/0xHelico/helico/blob/e4582449a984340cfede5d6453c81b1a7e0b5154/contracts/src/Mandate.sol#L20-L62) |
| Committing it, checked against the position's real pool | [`HelicoVault.sol#L287-L310`](https://github.com/0xHelico/helico/blob/e4582449a984340cfede5d6453c81b1a7e0b5154/contracts/src/HelicoVault.sol#L287-L310) |
| The action the agent may propose | [`HelicoVault.sol#L519-L572`](https://github.com/0xHelico/helico/blob/e4582449a984340cfede5d6453c81b1a7e0b5154/contracts/src/HelicoVault.sol#L519-L572) |
| Every range rule, including the one the price must satisfy | [`HelicoVault.sol#L786-L810`](https://github.com/0xHelico/helico/blob/e4582449a984340cfede5d6453c81b1a7e0b5154/contracts/src/HelicoVault.sol#L786-L810) |
| The swap that makes an out-of-range position recoverable | [`HelicoVault.sol#L579-L595`](https://github.com/0xHelico/helico/blob/e4582449a984340cfede5d6453c81b1a7e0b5154/contracts/src/HelicoVault.sol#L579-L595) |
| An agent that cannot send transactions: the signed authorisation | [`HelicoVault.sol#L417-L437`](https://github.com/0xHelico/helico/blob/e4582449a984340cfede5d6453c81b1a7e0b5154/contracts/src/HelicoVault.sol#L417-L437) |
| The exit, which nothing can block | [`HelicoVault.sol#L320-L332`](https://github.com/0xHelico/helico/blob/e4582449a984340cfede5d6453c81b1a7e0b5154/contracts/src/HelicoVault.sol#L320-L332) |

### Chainlink CRE — Confidential Workflows

The decision about whether and where to re-centre runs **inside the enclave**, over thresholds
released there by the Vault DON. Only the verdict crosses back out.

| What | Where |
|---|---|
| `handlerInTee` registration | [`index.ts#L268-L276`](https://github.com/0xHelico/helico/blob/e4582449a984340cfede5d6453c81b1a7e0b5154/packages/plugins/cre/src/index.ts#L268-L276) |
| The confidential handler itself | [`index.ts#L173-L234`](https://github.com/0xHelico/helico/blob/e4582449a984340cfede5d6453c81b1a7e0b5154/packages/plugins/cre/src/index.ts#L173-L234) |
| The re-centre decision, Helico's own logic | [`index.ts#L111-L170`](https://github.com/0xHelico/helico/blob/e4582449a984340cfede5d6453c81b1a7e0b5154/packages/plugins/cre/src/index.ts#L111-L170) |
| Chain reads made from inside the enclave | [`chain.ts#L20-L44`](https://github.com/0xHelico/helico/blob/e4582449a984340cfede5d6453c81b1a7e0b5154/packages/plugins/cre/src/chain.ts#L20-L44) |
| The mandate hash, tying the verdict to what the user signed | [`mandate.ts#L38-L50`](https://github.com/0xHelico/helico/blob/e4582449a984340cfede5d6453c81b1a7e0b5154/packages/plugins/cre/src/mandate.ts#L38-L50) |

> ⚠️ **Not yet claimed.** The workflow's verdict does not yet drive the vault on chain.
> Confidential Workflows is an invite-only beta separate from CRE deploy access, so this runs
> in the CRE simulator; the simulator stands in for the enclave, and the README of the plugin
> says so where it matters. We would rather say that than imply a live DON deployment.

## Rules

This repository follows the ETHOnline 2026 rules. The one that matters most: **an
integration that does not genuinely work is a full disqualification**, not a deduction.

The rules that bind coding sessions live in [`CLAUDE.md`](CLAUDE.md).
AI usage is logged in [`AI-USAGE.md`](AI-USAGE.md).
