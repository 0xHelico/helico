# Helico

Submission for [ETHOnline 2026](https://ethglobal.com/events/ethonline2026)
(September 4–16, 2026).

**Giving an AI agent control over capital normally means surrendering custody.** You approve
tokens, trust the agent not to misbehave, and hope you can revoke in time. Helico replaces that
trust with limits the code enforces: the agent gets authority to act, and never gets your funds.

Three pieces, and each one answers a different way that authority usually leaks.

- **Your own contract, at an address that exists before it does.** Every owner gets a separate
  account, deployed with `CREATE2`, so it can be paid before they have ever sent a transaction.
  The way out lives in the proxy rather than the implementation behind it, so no upgrade can
  remove it — proven by installing a deliberately hostile implementation and showing the owner
  still gets everything back.
- **Trading through a 1inch Aqua mandate.** The tokens never leave the wallet at all. The app
  holds a ledger entry, not money, and docking the mandate ends it immediately.
- **A Chainlink CRE Confidential Workflow deciding where idle capital sits.** It weighs what is
  earning in Aave against what must stay liquid to cover a swap, and moves the difference when
  the gap is worth the gas. The authority it holds has no recipient parameter anywhere in the
  call, so it can choose where money works and has no way to send it elsewhere.

In all three, the agent proposes and the contract refuses anything outside the rules. The way
out is never blocked.

Nothing here is claimed before it is proven. Where something is not yet true, it is marked as
not yet true rather than left to be assumed — see [Rules](#rules) for why that matters.

## Layout

| Directory | Contents |
|---|---|
| [`contracts/`](contracts/) | `HelicoAccountFactory`, `HelicoAccount`, `HelicoMandateSwap`, `HelicoVault`, and their tests |
| [`packages/plugins/thegraph/`](packages/plugins/thegraph/) | The Graph queries, `@helico/plugin-thegraph` |
| [`subgraph/`](subgraph/) | The subgraph indexing Aqua's mandates |
| [`packages/plugins/uniswap/`](packages/plugins/uniswap/) | Uniswap v4 on-chain package, `@helico/plugin-uniswap` |
| [`packages/plugins/cre/`](packages/plugins/cre/) | Chainlink CRE confidential workflow, `@helico/plugin-cre` |
| [`packages/core/`](packages/core/) | Shared library, `@helico/core` |
| [`apps/landing/`](apps/landing/) | Landing page and blog, Astro |
| [`apps/be/`](apps/be/) | Blog API, Go and SQLite |
| [`apps/cre/`](apps/cre/) | The runnable CRE project, and `rehearse-idle.sh` |
| [`docs/plans/`](docs/plans/) | Implementation plans, written before the code |

The workflow's logic lives in `packages/plugins/cre` rather than in `apps/cre`, because every
partner integration here is a reusable package — and because that is what lets 208 unit tests
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

The decision about how much capital should be earning and how much must stay liquid runs
**inside the enclave**, over thresholds the Vault DON releases only there. The thresholds are
the strategy, and they are the one thing a competitor would want; only the verdict crosses back
out.

| What | Where |
|---|---|
| `handlerInTee` registration, and the confidential handler | [`packages/plugins/cre/src/index.ts`](packages/plugins/cre/src/index.ts) |
| The decision itself — target split, then deadband | [`src/decision.ts`](packages/plugins/cre/src/decision.ts) |
| The policy, and why it is secret rather than on chain | [`src/policy.ts`](packages/plugins/cre/src/policy.ts) |
| Chain reads made from inside the enclave | [`src/chain.ts`](packages/plugins/cre/src/chain.ts) |
| The EIP-712 statement the enclave signs | [`src/sign.ts`](packages/plugins/cre/src/sign.ts) |
| The account that accepts it, and what it refuses | [`contracts/src/HelicoAccount.sol`](contracts/src/HelicoAccount.sol) |

**Run it yourself:** `cp apps/cre/.env.example apps/cre/.env && cd apps/cre && ./rehearse-idle.sh`.

It forks Arbitrum One, deploys the account factory, opens an owner an account at an address
predicted before it existed, funds it with real USDC taken from a whale on the fork, lets the
workflow decide and sign, and carries the signed call to the chain. A recorded run: 50,000 USDC
in, `SUPPLY 40000000000`, and the account ends holding 39,999.999999 aUSDC against a 10,000 USDC
buffer — one unit short because Aave rounds against the supplier.

The last thing it checks is the agent's own USDC balance, which is zero. A transaction that
succeeds and moves nothing reads in a log exactly like one that worked, so the balances are the
only thing worth believing.

> ⚠️ **What that run does not show.** The simulator is **not a TEE** — it says so itself while
> running, and names the enclave it would use in production (AWS Nitro, us-west-2). So the run
> proves the workflow compiles for the CRE runtime, reads the chain, decides, signs, and that
> the signed call lands and moves capital. It does not prove DON authorisation or attestation.
> It is also a fork, not a live network.
>
> Chainlink's own qualification text accepts *"a Confidential Workflow simulation using the CRE
> CLI **or** a live deployment"*, so this is evidence rather than a stand-in for it.

> ⚠️ **The model explains; it does not decide.** An LLM turns the verdict into a sentence the
> owner can read, and the verdict is computed before it is called and never reads its answer
> back. The reason that call needs an enclave at all is that a normal workflow asks every node
> and takes a consensus — ten nodes asking a model the same question get ten different answers,
> and free text has no median. Inside the enclave the call happens once.

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

#### One wallet, three positions, no deposit

Aqua is an allowance ledger rather than a vault, and the consequence is easy to state and easier
to disbelieve: **opening a position moves no tokens at all.** `ship` writes an entry; the tokens
are only touched when a fill happens, straight from the maker to the recipient.

So one wallet's balance can back several positions at once.
[`@helico/plugin-1inch`](packages/plugins/1inch/) builds them, priced by 1inch's deployed SwapVM
rather than by arithmetic of ours, and one command shows it on a fork of Arbitrum One:

```sh
anvil --fork-url https://arb1.arbitrum.io/rpc --port 8549 --silent &
bun scripts/check-aqua.ts
```

```
ship $2,800–3,200   3 Aqua events, 0 token transfers
ship $2,900–3,100   3 Aqua events, 0 token transfers
ship $1,000–9,000   3 Aqua events, 0 token transfers

wallet after    10000000000000000000 WETH   20000000000 USDC
moved           0 WETH   0 USDC
committed       30000000000000000000 WETH against 10000000000000000000 held  —  300%

  $2,800–3,200   1,000 USDC -> 0.337011 WETH   @ $2967.26
  $2,900–3,100   1,000 USDC -> 0.334501 WETH   @ $2989.53
  $1,000–9,000   1,000 USDC -> 0.386875 WETH   @ $2584.81
```

Three concentrated ranges on the same ten ETH and twenty thousand USDC. **On a pool this is three
positions and the capital split three ways**; here it is three ledger writes and the wallet is as
full afterwards as it was before. The price spread across them is the concentration effect — the
same money quoted tighter fills better.

300% committed is not leverage. `pull` ends in `safeTransferFrom` from the maker's own wallet, so
whichever strategy fills first gets the tokens and the rest revert. It is a number an agent has to
watch rather than a position it can hold, which is exactly the job the enclave and the subgraph do
here: nothing on chain can list a maker's strategies, and after a fill the ones left over quote
prices the wallet can no longer honour.

> The pricing is 1inch's on purpose. `concentrate` is one of thirteen instructions their SDK
> ships, and `xyc-swap` — the one `HelicoMandateSwap` implements by hand — is the baseline their
> own example is named after. The three ways this integration can be wrong *without reverting*
> are in [the plugin's README](packages/plugins/1inch/README.md), each with a test.

#### SwapVM, with one instruction of ours

**Powered by SwapVM — © Degensoft Ltd 2025.** [`contracts/src/swapvm/`](contracts/src/swapvm/)
carries a redeployment of Degensoft's `AquaSwapVMRouter` with one instruction added. Their VM,
their transfer phase, their Aqua accounting and every published instruction are unchanged and
used as released; the addition is opcode 34, and it is
[marked as ours](contracts/src/swapvm/AquaYieldCover.sol) under
[their licence](https://github.com/1inch/swap-vm/blob/main/LICENSES/SwapVM-1.1.txt).

The licence is what permits it, and it is specific rather than incidental: §4 makes
non-commercial use free of charge and names **hackathons** among the uses it means, subject to
§3 for modifications. §3.1 then lists what a modification owes, and all five are paid here — the
same licence on our files, upstream notices preserved, this attribution, the changes marked and
dated in each docblock, and build and deploy instructions in
[the runbook](docs/deploy-runbook.md).

§3.1C asks for that attribution in the README *and in the UI where applicable*. It is not
applicable yet — nothing in `apps/app` builds a SwapVM program — and it becomes applicable the
moment one does. Written here rather than left to be noticed later, because "where applicable"
is the kind of clause that is satisfied on the day it is read and quietly breached on the day
the feature ships.

**What it does that no published instruction can.** Every curve SwapVM ships prices against
`balanceOut`, and Aqua answers that from what the maker *shipped* — a ledger number, written with
no transfer and no balance check. So a maker may commit 43,000 USDC while holding 5,000. The
curve is right to price against 43,000; what breaks is the end of the swap, where `_transferOut`
pulls the tokens themselves and tokens earning yield elsewhere are not there to pull. Nothing in
the published set closes that, because none of those instructions has a concept of a lending
market — they compute prices. `_aquaYieldCoverXD` moves capital, once, for exactly the shortfall,
inside the transaction that needs it.

**Measured on a fork of Arbitrum One**, against the canonical Aqua, real USDC and a real Aave
position — [`ForkSwapVMYieldCover.t.sol`](contracts/test/ForkSwapVMYieldCover.t.sol):

```
liquid before    5,000 USDC
supplied before 38,000 USDC   (earning in Aave v3)
paid to taker    8,600 USDC   ← more than the wallet held
supplied after  34,400 USDC   (3,600 unwound mid-swap, and no more)
```

Run it with `FOUNDRY_PROFILE=swapvm forge test --match-path test/ForkSwapVMYieldCover.t.sol`.
SwapVM needs the IR pipeline, so it builds under its own profile; the default one does not
compile these files, and CI builds both.

### The Graph

> **Deployed to Subgraph Studio, indexing the live Aqua, and caught up.** The subgraph is in
> [`subgraph/`](subgraph/); `@helico/plugin-thegraph` queries it, and so does the CRE workflow
> when it is given the endpoint; one command shows what comes back, and prints `_meta` first:
>
> ```sh
> bun scripts/check-subgraph.ts
> ```
>
> It holds **47 makers and 158 mandates**, from block 485,793,304 to 502,288,683.
>
> Two mistakes got it here, and the check that catches both is one query. It indexed
> `0x499943E7…` until 7 September — a real Aqua, with real events, silent since block
> 451,737,844 ([#165](https://github.com/0xHelico/helico/issues/165)). Then the corrected
> manifest deployed to a Studio slug nobody queries, so the fix reached no one
> ([#183](https://github.com/0xHelico/helico/pull/183)). Both times the endpoint answered,
> `hasIndexingErrors` was false, and `_meta` tracked the chain head.
>
> **The oldest entity an endpoint serves cannot predate the first log of the contract it
> indexes.** Oldest mandate 485,793,304 against a first log at 485,505,646 — that is what
> separates "this endpoint is up" from "this endpoint read the contract we meant".

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

The subgraph answers exactly that, and `makerMandates` in `@helico/plugin-thegraph` is the call
that asks. Against the live endpoint, for the busiest maker on this chain:

```
maker     0xef9f7f4006fe95afede04f6916e72556a957ebbc
mandates  48, of which 11 still active

still spendable, summed across active mandates:
  0xda10009c…  99786406005223823281      0xaf88d065…  127320132
  0x3ed03e95…  350031126307346128835     0x82af4944…  44591582476515318
  0xfd086bc7…  80614207
```

Not our wallet and not our app — that is the point. **Forty-eight strategies under one address,
five tokens, and no way on chain to learn that any of them exist.** The docked ones come back
marked docked rather than merely empty, which is Aqua's own three-state sentinel and the
distinction the schema exists to preserve.

Still planned: the enclave consuming this as a second private input alongside the mandate
thresholds, and the Subgraph MCP server so the agent discovers the schema rather than having it
hard-coded.

| What | Where |
|---|---|
| The mandate a maker ships, and what each field is for | [`HelicoMandateSwap.sol#L37-L90`](https://github.com/0xHelico/helico/blob/247db3ba454ba058411f958850f38bc7c1739cca/contracts/src/HelicoMandateSwap.sol#L37-L90) |
| The swap: gate, rules, quote, ceiling, then settle | [`HelicoMandateSwap.sol#L229-L256`](https://github.com/0xHelico/helico/blob/247db3ba454ba058411f958850f38bc7c1739cca/contracts/src/HelicoMandateSwap.sol#L229-L256) |
| Delivery before payment, and the check that makes it safe | [`HelicoMandateSwap.sol#L378-L393`](https://github.com/0xHelico/helico/blob/247db3ba454ba058411f958850f38bc7c1739cca/contracts/src/HelicoMandateSwap.sol#L378-L393) |
| A quote anyone may ask for, under the same rules | [`HelicoMandateSwap.sol#L196-L206`](https://github.com/0xHelico/helico/blob/247db3ba454ba058411f958850f38bc7c1739cca/contracts/src/HelicoMandateSwap.sol#L196-L206) |

**Two corrections, kept rather than quietly edited, because the second overturns the first.**

This section once said Aqua on Arbitrum One was empty. That was wrong, and the reason was a
query that asked for the last 10,000,000 blocks when the most recent event was 49 million blocks
old — absence of evidence read as evidence of absence.

Then the address itself turned out to be wrong. We had taken it from the README inside the
`v1.0.0` tag we vendor, which is from March; 1inch's current README lists a different one and
says *"Only interact with these two contracts. Anything else is not Aqua."* They confirmed it
directly. So the 1,289 events are real, and they belong to a deployment 1inch does not call Aqua.

The canonical address — `0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a` — is **live and busier**.
An earlier version of this paragraph said it carried no events at all, which was a measurement
we asserted without running. Measured properly on 8 September: it answers `eth_getLogs` with
events through the current head, while the stale address has been silent since block
451,737,844.

So activity cannot tell the two apart, and that is the point worth keeping. Counting events
picks the wrong contract; counting *recent* events picks the right one for a reason that is luck
rather than evidence. What actually separates them is the vendor's own SDK constant and the
deployed `AquaSwapVMRouter`, which carries this address in its bytecode and no reference to the
other.

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
