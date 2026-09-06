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
| [`apps/landing/`](apps/landing/) | Landing page and blog, Astro |
| [`apps/be/`](apps/be/) | Blog API, Go and SQLite |
| [`apps/cre/`](apps/cre/) | The runnable CRE project, and `rehearse.sh` |
| [`docs/plans/`](docs/plans/) | Implementation plans, written before the code |

The workflow's logic lives in `packages/plugins/cre` rather than in `apps/cre`, because every
partner integration here is a reusable package — and because that is what lets 116 unit tests
cover the enclave's decision without the CRE CLI in the loop. `apps/cre` is what the CLI
compiles and simulates.

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
| Universal Router `execute`, `V4_SWAP` command, router-level `SWEEP` | [`swap.ts#L100-L121`](https://github.com/0xHelico/helico/blob/9b1e8194098425ddab6cdaabc95d6796c5de9fcf/packages/plugins/uniswap/src/swap.ts#L100-L121) |
| `SWAP_EXACT_IN_SINGLE` action and its settlement pair | [`swap.ts#L148-L170`](https://github.com/0xHelico/helico/blob/9b1e8194098425ddab6cdaabc95d6796c5de9fcf/packages/plugins/uniswap/src/swap.ts#L148-L170) |
| `Quoter` read over `eth_call` | [`quote.ts#L17-L28`](https://github.com/0xHelico/helico/blob/9b1e8194098425ddab6cdaabc95d6796c5de9fcf/packages/plugins/uniswap/src/quote.ts#L17-L28) |
| Pool state through `StateView` | [`pool.ts#L64-L82`](https://github.com/0xHelico/helico/blob/9b1e8194098425ddab6cdaabc95d6796c5de9fcf/packages/plugins/uniswap/src/pool.ts#L64-L82) |
| `PoolId` derivation, matching v4's own | [`pool.ts#L39-L52`](https://github.com/0xHelico/helico/blob/9b1e8194098425ddab6cdaabc95d6796c5de9fcf/packages/plugins/uniswap/src/pool.ts#L39-L52) |
| Addresses resolved from the official SDK | [`addresses.ts#L99-L107`](https://github.com/0xHelico/helico/blob/9b1e8194098425ddab6cdaabc95d6796c5de9fcf/packages/plugins/uniswap/src/addresses.ts#L99-L107) |
| Permit2 approval | [`approval.ts#L93-L110`](https://github.com/0xHelico/helico/blob/9b1e8194098425ddab6cdaabc95d6796c5de9fcf/packages/plugins/uniswap/src/approval.ts#L93-L110) |
| EIP-712 `PermitSingle` typed data | [`approval.ts#L134-L160`](https://github.com/0xHelico/helico/blob/9b1e8194098425ddab6cdaabc95d6796c5de9fcf/packages/plugins/uniswap/src/approval.ts#L134-L160) |
| `PositionManager` mint | [`liquidity.ts#L93-L124`](https://github.com/0xHelico/helico/blob/9b1e8194098425ddab6cdaabc95d6796c5de9fcf/packages/plugins/uniswap/src/liquidity.ts#L93-L124) |

### The vault

`HelicoVault` enforces a user's committed mandate on the agent that re-centres their position.
It is upgradeable behind a timelock, non-custodial, and every rejection path is a test — see
[`contracts/README.md`](contracts/README.md) for what a rogue agent can and cannot do.

| What | Where |
|---|---|
| The mandate a user commits | [`Mandate.sol#L20-L62`](https://github.com/0xHelico/helico/blob/9b1e8194098425ddab6cdaabc95d6796c5de9fcf/contracts/src/Mandate.sol#L20-L62) |
| Committing it, checked against the position's real pool | [`HelicoVault.sol#L290-L328`](https://github.com/0xHelico/helico/blob/9b1e8194098425ddab6cdaabc95d6796c5de9fcf/contracts/src/HelicoVault.sol#L290-L328) |
| The action the agent may propose | [`HelicoVault.sol#L537-L590`](https://github.com/0xHelico/helico/blob/9b1e8194098425ddab6cdaabc95d6796c5de9fcf/contracts/src/HelicoVault.sol#L537-L590) |
| Every range rule, including the one the price must satisfy | [`HelicoVault.sol#L843-L867`](https://github.com/0xHelico/helico/blob/9b1e8194098425ddab6cdaabc95d6796c5de9fcf/contracts/src/HelicoVault.sol#L843-L867) |
| The swap that makes an out-of-range position recoverable | [`HelicoVault.sol#L597-L613`](https://github.com/0xHelico/helico/blob/9b1e8194098425ddab6cdaabc95d6796c5de9fcf/contracts/src/HelicoVault.sol#L597-L613) |
| An agent that cannot send transactions: the signed authorisation | [`HelicoVault.sol#L435-L455`](https://github.com/0xHelico/helico/blob/9b1e8194098425ddab6cdaabc95d6796c5de9fcf/contracts/src/HelicoVault.sol#L435-L455) |
| The exit, which nothing can block | [`HelicoVault.sol#L338-L350`](https://github.com/0xHelico/helico/blob/9b1e8194098425ddab6cdaabc95d6796c5de9fcf/contracts/src/HelicoVault.sol#L338-L350) |

### Chainlink CRE — Confidential Workflows

The decision about whether and where to re-centre runs **inside the enclave**, over thresholds
released there by the Vault DON. Only the verdict crosses back out.

| What | Where |
|---|---|
| `handlerInTee` registration | [`index.ts#L268-L276`](https://github.com/0xHelico/helico/blob/9b1e8194098425ddab6cdaabc95d6796c5de9fcf/packages/plugins/cre/src/index.ts#L268-L276) |
| The confidential handler itself | [`index.ts#L173-L234`](https://github.com/0xHelico/helico/blob/9b1e8194098425ddab6cdaabc95d6796c5de9fcf/packages/plugins/cre/src/index.ts#L173-L234) |
| The re-centre decision, Helico's own logic | [`index.ts#L111-L170`](https://github.com/0xHelico/helico/blob/9b1e8194098425ddab6cdaabc95d6796c5de9fcf/packages/plugins/cre/src/index.ts#L111-L170) |
| Chain reads made from inside the enclave | [`chain.ts#L20-L44`](https://github.com/0xHelico/helico/blob/9b1e8194098425ddab6cdaabc95d6796c5de9fcf/packages/plugins/cre/src/chain.ts#L20-L44) |
| The mandate hash, tying the verdict to what the user signed | [`mandate.ts#L38-L50`](https://github.com/0xHelico/helico/blob/9b1e8194098425ddab6cdaabc95d6796c5de9fcf/packages/plugins/cre/src/mandate.ts#L38-L50) |

| The verdict delivered to the vault | [`index.ts#L244-L265`](https://github.com/0xHelico/helico/blob/9b1e8194098425ddab6cdaabc95d6796c5de9fcf/packages/plugins/cre/src/index.ts#L244-L265) |
| The vault receiving it | [`HelicoVault.sol#L485-L498`](https://github.com/0xHelico/helico/blob/9b1e8194098425ddab6cdaabc95d6796c5de9fcf/contracts/src/HelicoVault.sol#L485-L498) |

**Run it yourself:** `cp apps/cre/.env.example apps/cre/.env && cd apps/cre && ./rehearse.sh`.
It forks Arbitrum One, deploys the vault onto the fork, gives it a position that has drifted
out of range, and lets the workflow decide and deliver. A second run holds on the cooldown.

> ⚠️ **What that run does not show.** The simulator is **not a TEE** — it says so itself while
> running — and the `MockKeystoneForwarder` the CLI broadcasts through **verifies no DON
> signatures**. So the run proves the delivery path and the vault's execution, not
> authorisation by a decentralised oracle network. It is also a fork, not a live network.
>
> Chainlink's own qualification text accepts *"a Confidential Workflow simulation using the CRE
> CLI **or** a live deployment"*, so this is evidence rather than a stand-in for it. A live
> deployment additionally needs the Confidential Workflows beta, which is a Chainlink gate and
> not a hackathon requirement.
>
> ⚠️ **A transaction hash is not evidence on this path.** `KeystoneForwarder` calls the
> receiver inside a `try`: a reverting `onReport` still leaves a transaction with `status 1`.
> Only the position moving proves a re-centre, which is what `rehearse.sh` checks and how
> [#78](https://github.com/0xHelico/helico/issues/78) was found.

## Rules

This repository follows the ETHOnline 2026 rules. The one that matters most: **an
integration that does not genuinely work is a full disqualification**, not a deduction.

The rules that bind coding sessions live in [`CLAUDE.md`](CLAUDE.md).
AI usage is logged in [`AI-USAGE.md`](AI-USAGE.md).
