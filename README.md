# Helico

An ETHOnline 2026 submission: **an AI agent with authority over your money, but never custody of
it.**

Normally you give an agent a token approval and hope. Here the agent gets permission to act, the
contract refuses anything outside your rules, and the way out is never blocked. Three ideas, one
each for a way authority usually leaks:

- **Your own contract.** Each owner gets a separate account at a `CREATE2` address, so it can be
  paid before it exists. The escape hatch lives in the proxy, not the implementation. We installed
  a deliberately hostile implementation and the owner still got everything back.
- **A 1inch Aqua mandate.** Tokens never leave your wallet. The app holds a ledger entry, not
  money, and docking ends it immediately.
- **A Chainlink CRE Confidential Workflow.** It decides how much idle capital should be earning,
  how much must stay liquid, and which of three lending protocols pays best right now. None of the
  calls it may make takes a recipient, so it can choose where money works and has no way to send it
  anywhere else.

Nothing here is claimed before it is proven. What is not true yet is listed at the bottom.

## The proof, in one transaction

Nobody on this team signed this. The enclave decided, Chainlink's `KeystoneForwarder` routed the
report, our agent contract refused every other sender, and the account moved its own money into the
market paying most.

```
tx      0x0668c698cf3d396e622a97bfa3e21016de44fb41863fa7cb69b47bd126f9ed27
from    0x3A8dBD6b…                     a DON node, not us
result  0.49 USDC into Morpho at 4.40%, against Aave at 2.75% and Compound at 2.86%
        0.01 USDC left liquid, the floor the owner sealed into the Vault DON
```

## Try it

Deployed and open. Nothing has to be run locally.

**[app.helico.site](https://app.helico.site)**, on Arbitrum One. One signature proves the address is
yours; it costs no gas and moves nothing. Then: turn everything on in one confirmation on a wallet
that can batch, move USDC in, and say what you want. Every one of those is a call you sign, and
naming the agent or allowing a market is owner-only on chain, so no batch or relayer can make them
for you.

## Three tracks

At most three partners may be named. Uniswap v4 is real and tested here and is not one of them.

| Track | What is integrated | Check it yourself | Depth |
|---|---|---|---|
| **Chainlink** | A Confidential Workflow, registered with `handlerInTee`, executing on the DON every five minutes. It moved real money on 11 September. | `cd apps/cre && ./rehearse-idle.sh` | [chainlink.md](docs/tracks/chainlink.md) |
| **1inch** | Two Aqua apps of our own, one SwapVM instruction, and the aggregation route behind them. | `bun scripts/check-aqua.ts` | [1inch.md](docs/tracks/1inch.md) |
| **The Graph** | All five Aqua events plus our own factory, live on Studio, read by the dapp and the enclave. | `bun scripts/check-subgraph.ts` | [thegraph.md](docs/tracks/thegraph.md) |

Uniswap's own evidence is kept in [uniswap.md](docs/tracks/uniswap.md), because the code and its
transactions are real even though the track is not submitted.

### The lines behind each claim

Pinned to the commit they were read from, and checked in CI by
[`scripts/check-readme-links.py`](scripts/check-readme-links.py), because a permalink to the wrong
lines is worse than none. The track pages above carry the rest.

| What | Where |
|---|---|
| The confidential handler: the only decision this product makes | [`index.ts#L470-L596`](https://github.com/0xHelico/helico/blob/f6f2fc6695e030d8a6918a863470299fcb8dd179/packages/plugins/cre/src/index.ts#L470-L596) |
| How much should be earning, and what stops a move | [`decision.ts#L152-L193`](https://github.com/0xHelico/helico/blob/f6f2fc6695e030d8a6918a863470299fcb8dd179/packages/plugins/cre/src/decision.ts#L152-L193) |
| The policy, read from the Vault DON and never logged | [`policy.ts#L79-L91`](https://github.com/0xHelico/helico/blob/f6f2fc6695e030d8a6918a863470299fcb8dd179/packages/plugins/cre/src/policy.ts#L79-L91) |
| Signing inside the enclave | [`sign.ts#L76-L86`](https://github.com/0xHelico/helico/blob/f6f2fc6695e030d8a6918a863470299fcb8dd179/packages/plugins/cre/src/sign.ts#L76-L86) |
| The mandate a maker ships, field by field | [`HelicoMandateSwap.sol#L37-L90`](https://github.com/0xHelico/helico/blob/247db3ba454ba058411f958850f38bc7c1739cca/contracts/src/HelicoMandateSwap.sol#L37-L90) |
| The swap: gate, rules, quote, ceiling, settle | [`HelicoMandateSwap.sol#L229-L256`](https://github.com/0xHelico/helico/blob/247db3ba454ba058411f958850f38bc7c1739cca/contracts/src/HelicoMandateSwap.sol#L229-L256) |
| Both sides of a board, from the feed and the inventory | [`HelicoOracleBoard.sol#L121-L126`](https://github.com/0xHelico/helico/blob/0052b8a7fccad523132017fffb911367e51e0607/contracts/src/HelicoOracleBoard.sol#L121-L126) |
| The aggregation transaction, and why its simulation is skipped | [`api.ts#L136-L166`](https://github.com/0xHelico/helico/blob/c2d17bbf89641ee70868891d77aab15906d360e1/packages/plugins/1inch/src/api.ts#L136-L166) |
| What a live Aqua position can actually pay | [`aqua-swap.ts#L115-L124`](https://github.com/0xHelico/helico/blob/dc9e8bc219092093887883fcd820866e811ece0b/apps/app/lib/aqua-swap.ts#L115-L124) |
| The six paths our 1inch proxy forwards, and no others | [`oneinch-proxy.ts#L19-L26`](https://github.com/0xHelico/helico/blob/c2d17bbf89641ee70868891d77aab15906d360e1/apps/app/lib/oneinch-proxy.ts#L19-L26) |
| The question the chain cannot answer, asked and paged | [`mandates.ts#L115-L141`](https://github.com/0xHelico/helico/blob/f6f2fc6695e030d8a6918a863470299fcb8dd179/packages/plugins/thegraph/src/mandates.ts#L115-L141) |
| A fill written as what the log carries, and nothing more | [`router.ts#L18-L45`](https://github.com/0xHelico/helico/blob/85fa79fa4d82f92b7f55c027c1fe2932043d716b/subgraph/src/router.ts#L18-L45) |

## Layout

| Directory | Contents |
|---|---|
| [`contracts/`](contracts/) | The account, the two Aqua apps, the SwapVM instruction, the lending venues |
| [`apps/app/`](apps/app/) | The dapp, at [app.helico.site](https://app.helico.site) |
| [`apps/be/`](apps/be/) | Go backend: sessions, chat, a cached subgraph read, an account's own history |
| [`apps/landing/`](apps/landing/) | [helico.site](https://helico.site) and the blog, Astro |
| [`apps/cre/`](apps/cre/) | The runnable CRE project, and `rehearse-idle.sh` |
| [`packages/plugins/`](packages/plugins/) | One package per partner: `cre`, `1inch`, `thegraph`, `uniswap` |
| [`subgraph/`](subgraph/) | The subgraph indexing Aqua and our factory |
| [`docs/tracks/`](docs/tracks/) | The measurements behind each track |
| [`docs/plans/`](docs/plans/) | Implementation plans, written before the code |

The workflow's logic lives in a package rather than in `apps/cre`, which is what lets 241 unit
tests cover the enclave's decision without the CRE CLI in the loop.

## What is not done

Said here rather than left to be discovered.

- **The local rehearsal is not a TEE.** It runs in the CRE simulator, which prints that while
  running, against a fork. The deployed workflow is a different thing and does execute on the DON.
- **No mandate has been shipped to our Aqua app on the live chain.** The account can be the maker
  from the dapp and the path is proven on a fork; on Arbitrum One, `agent` names a contract and an
  EOA can never be one, so a taker is still missing.
- **A maker position backed by wallet tokens has no interface**, only
  [`scripts/ship-maker-position.ts`](scripts/ship-maker-position.ts).
- **Nothing has been shipped to `HelicoOracleBoard`.** It is deployed and verified; deployed is not
  in use.
- **This is not audited.** Twelve automated reviewers went over the two Aqua contracts on 8
  September. That is not an audit and nothing here calls it one.

## Rules

Coding rules are in [`CLAUDE.md`](CLAUDE.md). AI usage is logged in [`AI-USAGE.md`](AI-USAGE.md),
which records which parts were AI-assisted, the model, and the instructions given. A partner
integration that does not genuinely work is a full disqualification rather than a deduction, which
is why every claim above names the command that checks it.

**About the history.** Judges inspect commits. Eleven merges on `main` are squashed, made before
squash merging was switched off, so each shows as one commit rather than the work behind it: #67
was 19 commits, #84 was 10. Nothing is lost, and every original commit is still fetchable from
`refs/pull/N/head`. The other 290-odd merges carry their commits.
