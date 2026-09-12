---
title: Chainlink CRE
---

*Moved out of the root README on 12 September so that file stays short enough to be read. Nothing
here was rewritten: this is the same text, the same measurements and the same pinned links, in a
place a reader reaches when they want the depth rather than the claim.*

## Chainlink CRE

The decision runs **inside the enclave**, over thresholds the Vault DON releases only there. The
thresholds are the strategy, the one thing a competitor would want. Only the verdict comes back
out, as a report the DON signs and writes to Arbitrum One through Chainlink's `KeystoneForwarder`,
into [`HelicoAgent`](../../contracts/src/HelicoAgent.sol), the contract your account names as its agent.
No key of ours is in that path: the forwarder is the only address that can call the agent, and the
agent can only call the two functions the account lets an agent call.

| What | Where |
|---|---|
| `handlerInTee`, the registration the prize asks for | [`index.ts#L649-L657`](https://github.com/0xHelico/helico/blob/f6f2fc6695e030d8a6918a863470299fcb8dd179/packages/plugins/cre/src/index.ts#L649-L657) |
| The enclave callback, every step of a run | [`index.ts#L470-L596`](https://github.com/0xHelico/helico/blob/f6f2fc6695e030d8a6918a863470299fcb8dd179/packages/plugins/cre/src/index.ts#L470-L596) |
| One account read and judged | [`index.ts#L344-L384`](https://github.com/0xHelico/helico/blob/f6f2fc6695e030d8a6918a863470299fcb8dd179/packages/plugins/cre/src/index.ts#L344-L384) |
| The split, the deadband, and the market chosen | [`decision.ts#L152-L193`](https://github.com/0xHelico/helico/blob/f6f2fc6695e030d8a6918a863470299fcb8dd179/packages/plugins/cre/src/decision.ts#L152-L193) |
| The policy, released only into the enclave | [`policy.ts#L146-L157`](https://github.com/0xHelico/helico/blob/f6f2fc6695e030d8a6918a863470299fcb8dd179/packages/plugins/cre/src/policy.ts#L146-L157) |
| Its hash, which the enclave recomputes before touching the chain | [`policy.ts#L79-L91`](https://github.com/0xHelico/helico/blob/f6f2fc6695e030d8a6918a863470299fcb8dd179/packages/plugins/cre/src/policy.ts#L79-L91) |
| The report it writes through the forwarder | [`index.ts`, `deliver`](../../packages/plugins/cre/src/index.ts) |
| The contract that receives it, and refuses everyone else | [`HelicoAgent.sol`](../../contracts/src/HelicoAgent.sol), on chain at [`0x98c3…4463`](https://arbiscan.io/address/0x98c3979358A4e5086Da432CfE91F45aE2A854463#code) |
| The EIP-712 statement it signs instead, under `signature` delivery (staging) | [`sign.ts#L76-L86`](https://github.com/0xHelico/helico/blob/f6f2fc6695e030d8a6918a863470299fcb8dd179/packages/plugins/cre/src/sign.ts#L76-L86) |
| The buffer sized from live Aqua mandates | [`subgraph.ts#L431-L449`](https://github.com/0xHelico/helico/blob/f6f2fc6695e030d8a6918a863470299fcb8dd179/packages/plugins/cre/src/subgraph.ts#L431-L449) |
| Which may only raise the owner's floor, never lower it | [`subgraph.ts#L463-L466`](https://github.com/0xHelico/helico/blob/f6f2fc6695e030d8a6918a863470299fcb8dd179/packages/plugins/cre/src/subgraph.ts#L463-L466) |
| The account that accepts it, and what it refuses | [`HelicoAccount.sol`](../../contracts/src/HelicoAccount.sol) |

**Run it:** `cp apps/cre/.env.example apps/cre/.env && cd apps/cre && ./rehearse-idle.sh`

It forks Arbitrum One, opens an account at an address predicted before it existed, funds it with
real USDC from a whale, permits the four production markets, lets the workflow decide and sign
(staging still uses `signature` delivery), and lands the signed call. A recorded run from when it
permitted Aave alone: 50,000 USDC in, `SUPPLY 40000000000`, ending at 39,999.999999 aUSDC against
a 10,000 buffer, one unit short because Aave rounds against the supplier. Today it picks whichever
of the four pays most and refuses to pass unless the market it chose is the best-paying one. It
prints the agent's own balance, and it exits non-zero when the position did not change, because a
transaction that moves nothing reads in a log exactly like one that worked.

> **What that run does not show.** The simulator is not a TEE, and it says so while running. It
> proves the workflow compiles for the runtime, reads the chain, decides, signs, and that the call
> lands and moves capital. It does not prove DON authorisation or attestation, and it is a fork.
> Chainlink's own text accepts a CLI simulation *or* a live deployment.

> **The model explains; it does not decide.** The verdict is computed before the model is called
> and never reads its answer back. It needs an enclave because a normal workflow asks every node
> and takes a consensus. Ten nodes asking a model get ten answers, and free text has no median.

### Three protocols, one interface

A comparison inside one protocol family is a market picker. The enclave compares **across**
protocols, and the piece that lets it is an interface the markets never agreed to.

`ILendingVenue` carries Aave v3's own signatures, so Aave needs no adapter and everything else
does. `CompoundVenue` and `MorphoVenue` answer it on behalf of Comet and of any ERC-4626 vault.

**The venue is its own receipt**, and that one decision solves two problems at once. Both Aqua
apps ask a receipt for `UNDERLYING_ASSET_ADDRESS()`, Aave's spelling, which Comet spells
`baseToken()`. Nothing requires the receipt to be a different contract from the pool, so the venue
answers the question itself. It also settles burn authority: `_burn(msg.sender, …)` needs nobody's
permission, which is what lets a swap unwind a lending position in the same call. Aave gets that
for free because its Pool owns the aToken; these earn it by being the token.

**Rates arrive in three shapes and leave in one.** Aave publishes an annual ray, Comet a
per-second wad, and Morpho publishes no rate at all, so `MorphoVenue` measures one, sampling its
own share price against a `1e27` probe large enough that five minutes of drift is about `4.36e8`
units rather than less than one. Two independent methods, checked against each other on 10 September: the venue's
trailing measurement reports **446 bps**, and Morpho's own API reports a net APY of **458 bps** for
the same vault, arrived at without reading a rate from Morpho at all. Everything converts to
Aave's units before the enclave sees it, so the decision never learns which protocol answered.

Live on Arbitrum One, verified, each reading its own market:

| Venue | Address | Market | Rate, 10 September |
|---|---|---|---|
| Aave v3 Pool | [`0x794a6135…14aD`](https://arbiscan.io/address/0x794a61358D6845594F94dc1DB02A252b5b4814aD) | USDC and WETH, one pool for every reserve | 273 bps |
| `CompoundVenue` | [`0x1eC57cE1…BB2E`](https://arbiscan.io/address/0x1eC57cE1DdfdC7a4EbF4F54Aedee19ab73fcBB2E#code) | `cUSDCv3` | 287 bps |
| `MorphoVenue` | [`0xBBa798A6…c9A29`](https://arbiscan.io/address/0xBBa798A61f0D7D1AE51466Fd4045Cd2Ea25c9A29#code) | Steakhouse High Yield USDC, `bbqUSDC` | 446 bps |
| `CompoundVenue` | [`0xb0A125F5…18cD`](https://arbiscan.io/address/0xb0A125F539237b553025e2cb180f9C40B25918cD#code) | `cWETHv3` | 125 bps |

An account reaches exactly the venues its owner has named, and no others: `supplyIdle` is gated on
`permittedVenue`, and neither it nor `withdrawIdle` takes a recipient. That is the same rule that
makes a compromised agent harmless. The worst it can do is move the owner's money between the
owner's own places.

**Run it:** `anvil --fork-url $ARBITRUM_RPC_URL --port 8549 --silent & bun scripts/check-deployed.ts`

Forty-six checks against the addresses above rather than against a fresh copy of the source. The
difference being whether what is shown is what is on chain. It opens an account through the live
factory, reaches all three protocols from it, and puts five USDC and five dollars of ETH to work in
both assets, then moves the clock thirty days and requires both positions to be worth more than
they were. On a fork, because it ships to Aqua and it should not do that to the live registry.
