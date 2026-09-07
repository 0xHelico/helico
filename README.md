# Helico

Submission for [ETHOnline 2026](https://ethglobal.com/events/ethonline2026)
(September 4–16, 2026).

**Helico lets an agent act on your assets under rules you commit to on chain, so the agent
never has to be trusted.** There are two of them, built on the same idea:

- **A Uniswap v4 liquidity position, kept in range.** Which pool, how wide a band, how much may
  move, how often, until when. `HelicoVault` holds the rules; the position NFT stays yours.
- **A swap mandate on your own wallet, through 1inch Aqua.** How long it lives, which agent may
  act, and how much may leave per swap. `HelicoMandateSwap` holds the rules; the tokens never
  leave your wallet at all.

In both, the agent proposes and the contract refuses anything the mandate does not allow. The
way out is never blocked: revoking the NFT approval ends the first, docking the strategy ends
the second, and nothing the operator controls can stop either.

Nothing here is claimed before it is proven. Where something is not yet true, it is marked as
not yet true rather than left to be assumed — see [Rules](#rules) for why that matters.

## Layout

| Directory | Contents |
|---|---|
| [`contracts/`](contracts/) | `HelicoVault`, `HelicoMandateSwap`, and their tests |
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

**Three tracks are submitted: Chainlink, 1inch and The Graph.** A submission may name at most
three partners, and Uniswap v4 is not one of them — the vault still runs on v4 and its
integration is real and tested, but the prize track it belonged to is not being entered. It is
kept below because the code is part of what this product does, not because it is being claimed.

### Chainlink CRE — Confidential Workflows

The decision about whether and where to re-centre runs **inside the enclave**, over thresholds
released there by the Vault DON. Only the verdict crosses back out.

| What | Where |
|---|---|
| `handlerInTee` registration | [`index.ts#L303-L311`](https://github.com/0xHelico/helico/blob/85fe235e1a2fab7521bd5f7020d8ac1bd2505f00/packages/plugins/cre/src/index.ts#L303-L311) |
| The confidential handler itself | [`index.ts#L196-L269`](https://github.com/0xHelico/helico/blob/85fe235e1a2fab7521bd5f7020d8ac1bd2505f00/packages/plugins/cre/src/index.ts#L196-L269) |
| The re-centre decision, Helico's own logic | [`index.ts#L134-L193`](https://github.com/0xHelico/helico/blob/85fe235e1a2fab7521bd5f7020d8ac1bd2505f00/packages/plugins/cre/src/index.ts#L134-L193) |
| Chain reads made from inside the enclave | [`chain.ts#L20-L44`](https://github.com/0xHelico/helico/blob/89054c6fe9fdb8c7cfe7b978e11f9b37a1e42c25/packages/plugins/cre/src/chain.ts#L20-L44) |
| The mandate hash, tying the verdict to what the user signed | [`mandate.ts#L52-L64`](https://github.com/0xHelico/helico/blob/89054c6fe9fdb8c7cfe7b978e11f9b37a1e42c25/packages/plugins/cre/src/mandate.ts#L52-L64) |

| The verdict delivered to the vault | [`index.ts#L279-L300`](https://github.com/0xHelico/helico/blob/85fe235e1a2fab7521bd5f7020d8ac1bd2505f00/packages/plugins/cre/src/index.ts#L279-L300) |
| The vault receiving it | [`HelicoVault.sol#L504-L517`](https://github.com/0xHelico/helico/blob/89054c6fe9fdb8c7cfe7b978e11f9b37a1e42c25/contracts/src/HelicoVault.sol#L504-L517) |

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

### 1inch Aqua

`HelicoMandateSwap` is an Aqua app in which the strategy **is** the mandate: an expiry, a named
agent contract, and a per-token ceiling on what may leave the maker's wallet.

Liquidity never moves into the app, or into Aqua. `pull` goes from the maker straight to the
recipient and `push` from the taker straight to the maker, and a test asserts that Aqua and the
app both hold zero either side of a swap.

Aqua files a strategy under the hash of the bytes it is handed and never reads them, so every
field is enforced in [`HelicoMandateSwap.sol`](contracts/src/HelicoMandateSwap.sol) or nowhere.
28 tests cover it against a real `Aqua` deployed in `setUp` — nothing mocks Aqua or the app.
Every guard was then cut out, one at a time, to check the suite notices: **11 of 11 mutations
caught.** What that turned up, and the four limits it did not fix, are in
[`contracts/README.md`](contracts/README.md#helicomandateswap).

> Commit-pinned permalinks for this section arrive with the next pin refresh, not before. The
> checker compares every pin against every referenced file, so adding a file that does not
> exist in the currently pinned commit would fail the check for all the other rows. Pinning
> them together is the only honest way to do it.

### The Graph

> ⚠️ **Not built yet.** This section names the work rather than claiming it. It will say what
> was built, with a link to it, or it will be deleted — it will not stay a description.

Aqua cannot answer the question an agent has to ask first.

```solidity
mapping(address maker =>
    mapping(address app =>
        mapping(bytes32 strategyHash =>
            mapping(address token => Balance)))) private _balances;

event Shipped(address maker, address app, bytes32 strategyHash, bytes strategy);
```

The mapping is `private` and four levels deep, so it cannot be enumerated. **No event parameter
is `indexed`**, so logs cannot be filtered by maker, app or token — only by topic0. And
`rawBalances` requires a strategy hash you already know.

So *"which mandates does this maker have, and what is left in each?"* has no on-chain answer. For
an agent deciding what it is permitted to do for a wallet that just connected, that is not a
performance problem — it is the problem. An indexer is the only answer, which is what makes this
load-bearing rather than decorative.

Planned: a subgraph over Aqua on Arbitrum One filtered to our app, consumed by the enclave as a
second private input alongside the mandate thresholds, and the Subgraph MCP server so the agent
discovers the schema rather than having it hard-coded.

| What | Where |
|---|---|
| The mandate a maker ships, and what each field is for | [`HelicoMandateSwap.sol#L19-L60`](https://github.com/0xHelico/helico/blob/89054c6fe9fdb8c7cfe7b978e11f9b37a1e42c25/contracts/src/HelicoMandateSwap.sol#L19-L60) |
| The swap: gate, rules, quote, ceiling, then settle | [`HelicoMandateSwap.sol#L157-L183`](https://github.com/0xHelico/helico/blob/89054c6fe9fdb8c7cfe7b978e11f9b37a1e42c25/contracts/src/HelicoMandateSwap.sol#L157-L183) |
| Delivery before payment, and the check that makes it safe | [`HelicoMandateSwap.sol#L187-L202`](https://github.com/0xHelico/helico/blob/89054c6fe9fdb8c7cfe7b978e11f9b37a1e42c25/contracts/src/HelicoMandateSwap.sol#L187-L202) |
| A quote anyone may ask for, under the same rules | [`HelicoMandateSwap.sol#L126-L134`](https://github.com/0xHelico/helico/blob/89054c6fe9fdb8c7cfe7b978e11f9b37a1e42c25/contracts/src/HelicoMandateSwap.sol#L126-L134) |

One thing worth saying plainly: **Aqua on Arbitrum One is empty** — zero events across the last
10,000,000 blocks. Until somebody else ships a strategy there, this indexes our own activity.

### Uniswap v4 — real, tested, and not a submitted track

The plugin talks to v4 directly — no aggregator, no wrapper — and every claim here has an
on-chain transaction behind it on Base Sepolia, listed in
[`packages/plugins/uniswap/README.md`](packages/plugins/uniswap/README.md).

| What | Where |
|---|---|
| Universal Router `execute`, `V4_SWAP` command, router-level `SWEEP` | [`swap.ts#L100-L121`](https://github.com/0xHelico/helico/blob/89054c6fe9fdb8c7cfe7b978e11f9b37a1e42c25/packages/plugins/uniswap/src/swap.ts#L100-L121) |
| `SWAP_EXACT_IN_SINGLE` action and its settlement pair | [`swap.ts#L148-L170`](https://github.com/0xHelico/helico/blob/89054c6fe9fdb8c7cfe7b978e11f9b37a1e42c25/packages/plugins/uniswap/src/swap.ts#L148-L170) |
| `Quoter` read over `eth_call` | [`quote.ts#L17-L28`](https://github.com/0xHelico/helico/blob/89054c6fe9fdb8c7cfe7b978e11f9b37a1e42c25/packages/plugins/uniswap/src/quote.ts#L17-L28) |
| Pool state through `StateView` | [`pool.ts#L72-L90`](https://github.com/0xHelico/helico/blob/89054c6fe9fdb8c7cfe7b978e11f9b37a1e42c25/packages/plugins/uniswap/src/pool.ts#L72-L90) |
| `PoolId` derivation, matching v4's own | [`pool.ts#L47-L60`](https://github.com/0xHelico/helico/blob/89054c6fe9fdb8c7cfe7b978e11f9b37a1e42c25/packages/plugins/uniswap/src/pool.ts#L47-L60) |
| Addresses resolved from the official SDK | [`addresses.ts#L99-L107`](https://github.com/0xHelico/helico/blob/89054c6fe9fdb8c7cfe7b978e11f9b37a1e42c25/packages/plugins/uniswap/src/addresses.ts#L99-L107) |
| Permit2 approval | [`approval.ts#L93-L110`](https://github.com/0xHelico/helico/blob/89054c6fe9fdb8c7cfe7b978e11f9b37a1e42c25/packages/plugins/uniswap/src/approval.ts#L93-L110) |
| EIP-712 `PermitSingle` typed data | [`approval.ts#L134-L160`](https://github.com/0xHelico/helico/blob/89054c6fe9fdb8c7cfe7b978e11f9b37a1e42c25/packages/plugins/uniswap/src/approval.ts#L134-L160) |
| `PositionManager` mint | [`liquidity.ts#L93-L124`](https://github.com/0xHelico/helico/blob/89054c6fe9fdb8c7cfe7b978e11f9b37a1e42c25/packages/plugins/uniswap/src/liquidity.ts#L93-L124) |

### The vault

`HelicoVault` enforces a user's committed mandate on the agent that re-centres their position.
It is upgradeable behind a timelock, non-custodial, and every rejection path is a test — see
[`contracts/README.md`](contracts/README.md) for what a rogue agent can and cannot do.

| What | Where |
|---|---|
| The mandate a user commits | [`Mandate.sol#L23-L65`](https://github.com/0xHelico/helico/blob/89054c6fe9fdb8c7cfe7b978e11f9b37a1e42c25/contracts/src/Mandate.sol#L23-L65) |
| Committing it, checked against the position's real pool | [`HelicoVault.sol#L309-L347`](https://github.com/0xHelico/helico/blob/89054c6fe9fdb8c7cfe7b978e11f9b37a1e42c25/contracts/src/HelicoVault.sol#L309-L347) |
| The action the agent may propose | [`HelicoVault.sol#L556-L609`](https://github.com/0xHelico/helico/blob/89054c6fe9fdb8c7cfe7b978e11f9b37a1e42c25/contracts/src/HelicoVault.sol#L556-L609) |
| Every range rule, including the one the price must satisfy | [`HelicoVault.sol#L862-L886`](https://github.com/0xHelico/helico/blob/89054c6fe9fdb8c7cfe7b978e11f9b37a1e42c25/contracts/src/HelicoVault.sol#L862-L886) |
| The swap that makes an out-of-range position recoverable | [`HelicoVault.sol#L616-L632`](https://github.com/0xHelico/helico/blob/89054c6fe9fdb8c7cfe7b978e11f9b37a1e42c25/contracts/src/HelicoVault.sol#L616-L632) |
| An agent that cannot send transactions: the signed authorisation | [`HelicoVault.sol#L454-L474`](https://github.com/0xHelico/helico/blob/89054c6fe9fdb8c7cfe7b978e11f9b37a1e42c25/contracts/src/HelicoVault.sol#L454-L474) |
| The exit, which nothing can block | [`HelicoVault.sol#L357-L369`](https://github.com/0xHelico/helico/blob/89054c6fe9fdb8c7cfe7b978e11f9b37a1e42c25/contracts/src/HelicoVault.sol#L357-L369) |

## Rules

This repository follows the ETHOnline 2026 rules. The one that matters most: **an
integration that does not genuinely work is a full disqualification**, not a deduction.

The rules that bind coding sessions live in [`CLAUDE.md`](CLAUDE.md).
AI usage is logged in [`AI-USAGE.md`](AI-USAGE.md).

### Reading the history

Judges are asked to inspect the commit history, so this is better said here than discovered.

Eleven of the merges on `main` are **squashed merges**, made before squash and rebase merging
were switched off in the repository settings:
[#64](https://github.com/0xHelico/helico/pull/64),
[#65](https://github.com/0xHelico/helico/pull/65),
[#69](https://github.com/0xHelico/helico/pull/69),
[#70](https://github.com/0xHelico/helico/pull/70),
[#72](https://github.com/0xHelico/helico/pull/72),
[#75](https://github.com/0xHelico/helico/pull/75),
[#77](https://github.com/0xHelico/helico/pull/77),
[#84](https://github.com/0xHelico/helico/pull/84),
[#98](https://github.com/0xHelico/helico/pull/98),
[#102](https://github.com/0xHelico/helico/pull/102)
and [#67](https://github.com/0xHelico/helico/pull/67).

Each appears on `main` as one commit rather than as the work that produced it — #67 was 19
commits, #84 was 10.

**Nothing is lost.** The full sequence is on the pull request itself, which is also where the
review that shaped it lives, and the original commits stay fetchable even where the branch has
since been deleted — nine of these eleven have been:

```
git fetch origin refs/pull/67/head    # all 19, ending at 28498d6 docs(plans): plan the landing page
```

Every other merge on `main` is the work as it happened.
