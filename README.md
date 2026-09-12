# Helico

An ETHOnline 2026 submission: **an AI agent with authority over your money, but never custody of
it.**

Normally you give an agent a token approval and hope. Here the agent gets permission to act, the
contract refuses anything outside your rules, and the way out is never blocked.

Three ideas, one each for a way authority usually leaks:

- **Your own contract.** Each owner gets a separate account at a `CREATE2` address, so it can be
  paid before it exists. The escape hatch lives in the proxy, not the implementation — we
  installed a deliberately hostile implementation and the owner still got everything back.
- **A 1inch Aqua mandate.** Tokens never leave your wallet. The app holds a ledger entry, not
  money, and docking ends it immediately.
- **A Chainlink CRE Confidential Workflow.** It decides how much idle capital should be earning,
  how much must stay liquid, and which of three lending protocols pays best for it right now. None
  of the calls it may make takes a recipient, so it can choose where money works and has no way to
  send it anywhere else.

Nothing here is claimed before it is proven. Where something is not true yet, it says so.

## Try it

Deployed and open. Nothing has to be run locally.

**[app.helico.site](https://app.helico.site)** — connect a wallet on Arbitrum One. One signature
proves the address is yours; it costs no gas and moves nothing.

1. **Agree, and turn everything on.** The first run offers one switch. On a wallet that can batch
   (EIP-5792) it opens your account, names Helico's agent and allows all four markets in **one
   confirmation**. On a wallet that cannot, it says so and sends nothing, and the same button waits
   on [`/limit`](https://app.helico.site/limit).
2. **Put something in.** *Money in* on the limits page moves USDC from your wallet into your
   account. An ordinary transfer: no approval, and nothing granted to anybody. The agent moves what
   the **account** holds, so this is the step that gives it something to move.
3. **Say what you want.** Swap by sentence, ask what your position is doing, ask why nothing moved,
   start earning, stop the agent, or take everything back. Nine starters on the front door reach all
   eight things it can do.

Every one of those is a call you sign. Naming the agent and allowing a market are owner-only on
chain, and no batch or relayer can make them for you — which is the property that makes a
compromised agent harmless rather than a promise that it will behave.

**What is not there yet, said here rather than discovered:** a maker position from your own wallet
has no interface. The account can be the maker from the app (the *Provide liquidity* starter, below
under 1inch); a position backed by wallet tokens is a script
([`scripts/ship-maker-position.ts`](scripts/ship-maker-position.ts)), not a screen.

## Layout

| Directory | Contents |
|---|---|
| [`contracts/`](contracts/) | The account, the two Aqua apps, the SwapVM instruction, the lending venues |
| [`apps/app/`](apps/app/) | The dapp — [app.helico.site](https://app.helico.site) |
| [`apps/be/`](apps/be/) | Go backend: sessions, chat, a cached subgraph read |
| [`apps/landing/`](apps/landing/) | [helico.site](https://helico.site) and the blog, Astro |
| [`apps/cre/`](apps/cre/) | The runnable CRE project, and `rehearse-idle.sh` |
| [`packages/plugins/cre/`](packages/plugins/cre/) | The workflow's logic, `@helico/plugin-cre` |
| [`packages/plugins/thegraph/`](packages/plugins/thegraph/) | Subgraph queries, `@helico/plugin-thegraph` |
| [`packages/plugins/1inch/`](packages/plugins/1inch/) | Aqua and SwapVM, `@helico/plugin-1inch` |
| [`packages/plugins/uniswap/`](packages/plugins/uniswap/) | Uniswap v4, `@helico/plugin-uniswap` |
| [`subgraph/`](subgraph/) | The subgraph indexing Aqua and our factory |
| [`docs/plans/`](docs/plans/) | Implementation plans, written before the code |

The workflow's logic lives in a package rather than in `apps/cre`, which is what lets 241 unit
tests cover the enclave's decision without the CRE CLI in the loop.

## Three tracks: Chainlink, 1inch, The Graph

A submission may name at most three partners. Uniswap v4 is real and tested here but is not one of
them — it is kept below because it is part of what this product does, not because it is claimed.

### Chainlink CRE

The decision runs **inside the enclave**, over thresholds the Vault DON releases only there. The
thresholds are the strategy — the one thing a competitor would want. Only the verdict comes back
out — as a report the DON signs and writes to Arbitrum One through Chainlink's `KeystoneForwarder`,
into [`HelicoAgent`](contracts/src/HelicoAgent.sol), the contract your account names as its agent.
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
| The report it writes through the forwarder | [`index.ts`, `deliver`](packages/plugins/cre/src/index.ts) |
| The contract that receives it, and refuses everyone else | [`HelicoAgent.sol`](contracts/src/HelicoAgent.sol), on chain at [`0x98c3…4463`](https://arbiscan.io/address/0x98c3979358A4e5086Da432CfE91F45aE2A854463#code) |
| The EIP-712 statement it signs instead, under `signature` delivery (staging) | [`sign.ts#L76-L86`](https://github.com/0xHelico/helico/blob/f6f2fc6695e030d8a6918a863470299fcb8dd179/packages/plugins/cre/src/sign.ts#L76-L86) |
| The buffer sized from live Aqua mandates | [`subgraph.ts#L431-L449`](https://github.com/0xHelico/helico/blob/f6f2fc6695e030d8a6918a863470299fcb8dd179/packages/plugins/cre/src/subgraph.ts#L431-L449) |
| Which may only raise the owner's floor, never lower it | [`subgraph.ts#L463-L466`](https://github.com/0xHelico/helico/blob/f6f2fc6695e030d8a6918a863470299fcb8dd179/packages/plugins/cre/src/subgraph.ts#L463-L466) |
| The account that accepts it, and what it refuses | [`HelicoAccount.sol`](contracts/src/HelicoAccount.sol) |

**Run it:** `cp apps/cre/.env.example apps/cre/.env && cd apps/cre && ./rehearse-idle.sh`

It forks Arbitrum One, opens an account at an address predicted before it existed, funds it with
real USDC from a whale, permits the four production markets, lets the workflow decide and sign
(staging still uses `signature` delivery), and lands the signed call. A recorded run from when it
permitted Aave alone: 50,000 USDC in, `SUPPLY 40000000000`, ending at 39,999.999999 aUSDC against
a 10,000 buffer — one unit short because Aave rounds against the supplier. Today it picks whichever
of the four pays most and refuses to pass unless the market it chose is the best-paying one. It
prints the agent's own balance, and it exits non-zero when the position did not change, because a
transaction that moves nothing reads in a log exactly like one that worked.

> **What that run does not show.** The simulator is not a TEE — it says so while running. It
> proves the workflow compiles for the runtime, reads the chain, decides, signs, and that the call
> lands and moves capital. It does not prove DON authorisation or attestation, and it is a fork.
> Chainlink's own text accepts a CLI simulation *or* a live deployment.

> **The model explains; it does not decide.** The verdict is computed before the model is called
> and never reads its answer back. It needs an enclave because a normal workflow asks every node
> and takes a consensus — ten nodes asking a model get ten answers, and free text has no median.

#### Three protocols, one interface

A comparison inside one protocol family is a market picker. The enclave compares **across**
protocols, and the piece that lets it is an interface the markets never agreed to.

`ILendingVenue` carries Aave v3's own signatures, so Aave needs no adapter and everything else
does. `CompoundVenue` and `MorphoVenue` answer it on behalf of Comet and of any ERC-4626 vault.

**The venue is its own receipt**, and that one decision solves two problems at once. Both Aqua
apps ask a receipt for `UNDERLYING_ASSET_ADDRESS()` — Aave's spelling, which Comet spells
`baseToken()`. Nothing requires the receipt to be a different contract from the pool, so the venue
answers the question itself. It also settles burn authority: `_burn(msg.sender, …)` needs nobody's
permission, which is what lets a swap unwind a lending position in the same call. Aave gets that
for free because its Pool owns the aToken; these earn it by being the token.

**Rates arrive in three shapes and leave in one.** Aave publishes an annual ray, Comet a
per-second wad, and Morpho publishes no rate at all — so `MorphoVenue` measures one, sampling its
own share price against a `1e27` probe large enough that five minutes of drift is about `4.36e8`
units rather than less than one. Two independent methods, checked against each other on 10 September: the venue's
trailing measurement reports **446 bps**, and Morpho's own API reports a net APY of **458 bps** for
the same vault — arrived at without reading a rate from Morpho at all. Everything converts to
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
makes a compromised agent harmless — the worst it can do is move the owner's money between the
owner's own places.

**Run it:** `anvil --fork-url $ARBITRUM_RPC_URL --port 8549 --silent & bun scripts/check-deployed.ts`

Forty-six checks against the addresses above rather than against a fresh copy of the source — the
difference being whether what is shown is what is on chain. It opens an account through the live
factory, reaches all three protocols from it, and puts five USDC and five dollars of ETH to work in
both assets, then moves the clock thirty days and requires both positions to be worth more than
they were. On a fork, because it ships to Aqua and it should not do that to the live registry.

### 1inch Aqua

`HelicoMandateSwap` is an Aqua app where the strategy **is** the mandate: an expiry, a named agent
contract, and a per-token ceiling on what may leave the maker's wallet.

It is deployed on Arbitrum One at
[`0x0524a353…6041`](https://arbiscan.io/address/0x0524a353dfab33CD362593ae8e97707764Fb6041#code),
behind a proxy, alongside `HelicoOracleBoard` at
[`0xe8515af9…7d39`](https://arbiscan.io/address/0xe8515af92442A5CDa67D1F32D1c8a987ba7e7d39#code).
Both are verified as proxy **and** implementation, because verifying one leaves unverified
bytecode at the address this file names. Every deployment, including the ones these replaced and
why, is in [`docs/deployments.md`](docs/deployments.md).

Liquidity never enters the app or Aqua. `pull` goes maker → recipient, `push` goes taker → maker,
and a test asserts both hold zero either side of a swap. Aqua files a strategy under the hash of
bytes it never reads, so every field is enforced in our contract or nowhere. 28 tests run against
a real `Aqua` deployed in `setUp` — nothing is mocked — and every guard was cut out one at a time
to check the suite notices: **11 of 11 mutations caught.**

| What | Where |
|---|---|
| The mandate a maker ships, field by field | [`HelicoMandateSwap.sol#L37-L90`](https://github.com/0xHelico/helico/blob/247db3ba454ba058411f958850f38bc7c1739cca/contracts/src/HelicoMandateSwap.sol#L37-L90) |
| The swap: gate, rules, quote, ceiling, settle | [`HelicoMandateSwap.sol#L229-L256`](https://github.com/0xHelico/helico/blob/247db3ba454ba058411f958850f38bc7c1739cca/contracts/src/HelicoMandateSwap.sol#L229-L256) |
| Delivery before payment, and what makes it safe | [`HelicoMandateSwap.sol#L378-L393`](https://github.com/0xHelico/helico/blob/247db3ba454ba058411f958850f38bc7c1739cca/contracts/src/HelicoMandateSwap.sol#L378-L393) |
| A quote anyone may ask for, under the same rules | [`HelicoMandateSwap.sol#L196-L206`](https://github.com/0xHelico/helico/blob/247db3ba454ba058411f958850f38bc7c1739cca/contracts/src/HelicoMandateSwap.sol#L196-L206) |

**One wallet, three positions, no deposit.** Aqua is an allowance ledger, not a vault, so opening
a position moves no tokens at all. One wallet's balance can back several at once:

```sh
anvil --fork-url https://arb1.arbitrum.io/rpc --port 8549 --silent &
bun scripts/check-aqua.ts
```

```
ship $2,800–3,200   3 Aqua events, 0 token transfers
ship $2,900–3,100   3 Aqua events, 0 token transfers
ship $1,000–9,000   3 Aqua events, 0 token transfers

committed  30 WETH against 10 held  —  300%
moved      0 WETH   0 USDC
```

Three concentrated ranges on the same ten ETH. On a pool that is three positions and the capital
split three ways; here it is three ledger writes and the wallet is as full afterwards. 300% is not
leverage — `pull` ends in `safeTransferFrom` from the maker's own wallet, so whoever fills first
gets the tokens and the rest revert. Watching that is the agent's job, and it is exactly why the
subgraph is here. Pricing comes from 1inch's deployed SwapVM, not from arithmetic of ours;
[the plugin's README](packages/plugins/1inch/README.md) lists the three ways this can be wrong
*without reverting*, each with a test.

**And for real, with a refusal in front of each way it could go wrong.**
[`scripts/ship-maker-position.ts`](scripts/ship-maker-position.ts) is that sequence against Arbitrum
One rather than a fork. It ships one position and stops — filling is the taker's action — and it
refuses to run off chain 42161, without an explicit `CONFIRM=ship`, on any of the four addresses
this repository already uses, or on a wallet that does not hold both sides. The approval it leaves
behind is for exactly the amounts shipped, not unlimited.

The rehearsal is the part worth reading.
[`scripts/rehearse-ship.ts`](scripts/rehearse-ship.ts) runs that script **unchanged** against a
fork, on a wallet it generates, and makes every one of those refusals fire on purpose:

```
ok    a reserved address refuses
ok    an unfunded wallet refuses
ok    and approves nothing on the way out  — 0
ok    ship moved no tokens  — 20 USDC · 0.01 WETH
ok    the shipped position quotes near the feed  — 0.5 USDC -> 0.000203967213000518 WETH @ $2451.37 vs feed $2465.60
```

The last line is the only honest test that a position is live, and the first version of it was not a
test at all: it read the quote's two returned words as one number and passed on 6.7e150 WETH. It
would have passed identically on a position mispriced by 1e12 — the mistake `price.ts` exists to
prevent. Decoded properly the fill lands 0.58% under Chainlink, which is the 30bps fee plus the band
and nothing else produces that number.

#### A second app, because the first one cannot quote a one-sided maker

`HelicoMandateSwap` prices as a constant product, and that is a real limit rather than a
stylistic one: **the price *is* the ratio of the two sides**, so a maker holding only USDC has no
price at all. Which is exactly the maker this product is built for — their USDC is earning in a
lending market, and a fill is settled out of it mid-swap.

`HelicoOracleBoard` quotes that maker from a Chainlink feed, and brakes itself on Aqua's own
ledger:

```
bid = mid × (BPS − spread − skew) / BPS
ask = mid × (BPS + spread − skew) / BPS
```

Both sides shift **down** as base inventory accumulates, so selling into the board gets steadily
worse and buying the inventory back gets steadily better. Inventory is pushed home by the price
rather than by anyone watching — the behaviour a constant product gets for free, rebuilt on top of
a feed that knows nothing about who holds what.

Measured against the live ETH/USD feed on Arbitrum One, read from the chain rather than assumed:

```
chainlink ETH/USD  2483.504394
bid                2476.053880    empty inventory, the feed less 0.30%
ask                2490.954907
bid, half full     2451.218836    bent by half the skew
```

| What | Where |
|---|---|
| The board a maker ships, field by field | [`HelicoOracleBoard.sol#L83-L95`](https://github.com/0xHelico/helico/blob/0052b8a7fccad523132017fffb911367e51e0607/contracts/src/HelicoOracleBoard.sol#L83-L95) |
| Both sides, from the feed and the inventory | [`#L121-L126`](https://github.com/0xHelico/helico/blob/0052b8a7fccad523132017fffb911367e51e0607/contracts/src/HelicoOracleBoard.sol#L121-L126) |
| The skew that bends them, and why it is one-way | [`#L210-L216`](https://github.com/0xHelico/helico/blob/0052b8a7fccad523132017fffb911367e51e0607/contracts/src/HelicoOracleBoard.sol#L210-L216) |
| The feed read, with staleness refused rather than tolerated | [`#L194-L206`](https://github.com/0xHelico/helico/blob/0052b8a7fccad523132017fffb911367e51e0607/contracts/src/HelicoOracleBoard.sol#L194-L206) |
| The fill, and what it settles out of | [`#L144-L161`](https://github.com/0xHelico/helico/blob/0052b8a7fccad523132017fffb911367e51e0607/contracts/src/HelicoOracleBoard.sol#L144-L161) |
| The budget a fill may not exceed | [`#L222-L245`](https://github.com/0xHelico/helico/blob/0052b8a7fccad523132017fffb911367e51e0607/contracts/src/HelicoOracleBoard.sol#L222-L245) |

Six fork tests hold it to that, against the real feed and real USDC:
`ForkOracleBoard.t.sol` — a one-sided maker quoting the live market, the quote bending as
inventory accumulates, the cap **refusing** rather than merely discouraging, the inventory bought
back, a **stale feed refusing the fill**, and the spread being what the maker actually earns.

Four more say the fill is paid out of the lending position rather than out of the wallet, which is
the sentence at the top of this section and was the last part of it to become true
([`ForkOracleBoardYield.t.sol`](contracts/test/ForkOracleBoardYield.t.sol)):

```
liquid before      500 USDC
supplied before 29,500 USDC   (earning in Aave v3)
paid to taker    2,493 USDC   ← larger than the wallet held
supplied after  27,507 USDC
```

They also pin what it refuses: a fill the wallet covers never touches the market, the shipped
receipt budget bounds what may be unwound, and **a maker carrying debt is refused** — unwinding
collateral can liquidate them, and Aave's health checks do not run on our behalf.

`FixedPriceBoard` in `contracts/test/` is the step between the two, kept as a test fixture rather
than shipped: it proves a one-sided maker *can* provide liquidity on Aqua, and then proves why a
fixed price is not enough — the price does not move no matter how much is taken, so a moving
market converts the whole position at yesterday's number.

Until 9 September none of that could be reached from outside Solidity: nothing could encode a
`SwapMandate`, so the mandate half of this track lived entirely in Foundry.
[`packages/plugins/1inch/src/mandate.ts`](packages/plugins/1inch/src/mandate.ts) encodes one, and
[`scripts/check-deployed.ts`](scripts/check-deployed.ts) runs the whole path from TypeScript against
a fork of Arbitrum One — the encoder held against the contract's own `mandateHash` first, because
Aqua files a position under the hash of the raw bytes and an encoding wrong by one field ships
successfully and files under a hash nobody looks up.

```
0.1 WETH → 271.98 USDC   paid from the wallet, Aave untouched
2.0 WETH → 1,758.13 USDC wanted, 728.02 idle → the position unwound to 969.88
```

That is the sentence the product is built on, measured rather than asserted: the capital that
earns is the capital the mandate spends. What is still missing is a taker on Arbitrum One —
`agent` names a contract and an EOA can never be one — so no mandate has been shipped to the live
app yet.

**Powered by SwapVM — © Degensoft Ltd 2025.** [`contracts/src/swapvm/`](contracts/src/swapvm/) is
a redeployment of Degensoft's `AquaSwapVMRouter` with one instruction added. Their VM, transfer
phase, Aqua accounting and every published instruction are unchanged; the addition is opcode 34,
[marked as ours](contracts/src/swapvm/AquaYieldCover.sol) under
[their licence](https://github.com/1inch/swap-vm/blob/main/LICENSES/SwapVM-1.1.txt), whose §4
names hackathons and whose §3.1 obligations are all met — same licence on our files, upstream
notices kept, this attribution, changes marked and dated in each docblock, and build steps in
[the runbook](docs/deploy-runbook.md).

Why the instruction exists: every SwapVM curve prices against `balanceOut`, and Aqua answers that
from what the maker *shipped* — a number written with no transfer and no balance check. So a maker
may commit 43,000 USDC while holding 5,000. The curve is right; what breaks is `_transferOut`,
because tokens earning yield elsewhere are not there to pull. No published instruction can close
that — none of them has a concept of a lending market. `_aquaYieldCoverXD` unwinds exactly the
shortfall, once, inside the transaction that needs it. Measured on a fork against the canonical
Aqua, real USDC and a real Aave position
([`ForkSwapVMYieldCover.t.sol`](contracts/test/ForkSwapVMYieldCover.t.sol)):

```
liquid before    5,000 USDC
supplied before 38,000 USDC   (earning in Aave v3)
paid to taker    8,600 USDC   ← more than the wallet held
supplied after  34,400 USDC   (3,600 unwound mid-swap, and no more)
```

**And it composes with a concentrated band, which is the position rather than the plumbing.**
`concentrate` is 1inch's own instruction — it adds virtual reserves so a constant product prices
inside a price range. It has no idea where the inventory is. `_aquaYieldCoverXD` has no idea it is
quoting a band. Run together they are a **concentrated liquidity position whose capital earns in
Aave between fills and is unwound only when one needs it**, and nothing in the published
instruction set expresses that
([`ForkSwapVMConcentrateCover.t.sol`](contracts/test/ForkSwapVMConcentrateCover.t.sol)):

```
                 with the band   without it
paid to taker    10,183 USDC      8,600 USDC
```

The right-hand column is the run above — the same account, the same trade, the band removed. One
number could not have told a working band from an absent one, which is why the file measures both.

It takes **three** instructions, and the two-instruction pairing is impossible rather than merely
worse. `concentrate` requires `amountIn == 0 || amountOut == 0`, so it runs before any swap;
`_aquaYieldCoverXD` reads `ctx.swap.amountOut` and returns when it is zero, so it runs after one.
Both failing orderings are pinned in that file beside the working one.

#### A second 1inch surface: the aggregation route, for when no mandate can pay

Everything above is our own Aqua app. This is the other half of the same partner, and the reason
the product works for somebody who has not shipped a position of their own.

**Until 11 September the swap fell through to Uniswap v4 when Aqua had nothing to fill against**,
for one reason only: the aggregation API needs a key and we had none, while the v4 Quoter is an
on-chain call. So the most visible action in the product ended at a protocol we do not submit while
the partner we do submit sat behind a refusal. The chain is now:

```
Aqua  →  1inch aggregation  →  Uniswap v4
```

Aqua keeps everything it was doing — `provide` ships through it, the moment a position exists this
path takes it, and the fallbacks only run when it cannot. Uniswap stays **last** because it needs
no key and no service, so it still answers when a deployment has no 1inch key or 1inch rate-limits
us. Every tier is named in the card, because a swap that quietly changes venue reads as a claim.

| What | Where |
|---|---|
| The three tiers, and why each is where it is | [`swap-card.tsx`](apps/app/components/swap-card.tsx) |
| The transaction 1inch builds, and why its simulation is skipped | [`api.ts#L136-L166`](https://github.com/0xHelico/helico/blob/c2d17bbf89641ee70868891d77aab15906d360e1/packages/plugins/1inch/src/api.ts#L136-L166) |
| The plan: allowance read on chain, approval first, fill second | [`oneinch-swap.ts#L55-L132`](https://github.com/0xHelico/helico/blob/c2d17bbf89641ee70868891d77aab15906d360e1/apps/app/lib/oneinch-swap.ts#L55-L132) |
| The six shapes the proxy forwards, anchored at both ends | [`oneinch-proxy.ts#L19-L26`](https://github.com/0xHelico/helico/blob/c2d17bbf89641ee70868891d77aab15906d360e1/apps/app/lib/oneinch-proxy.ts#L19-L26) |
| Thirty a minute per caller, swept on a request rather than a timer | [`oneinch-proxy.ts#L45-L58`](https://github.com/0xHelico/helico/blob/c2d17bbf89641ee70868891d77aab15906d360e1/apps/app/lib/oneinch-proxy.ts#L45-L58) |

**The key never reaches the browser.** `NEXT_PUBLIC_` inlines a value into the client bundle, so a
prefixed key is a public key; the dapp asks `/api/1inch/…`, a route handler that adds the header.
The proxy forwards six path shapes and answers 404 for everything else — a proxy that forwards any
path is a way for anybody to spend our quota on anything 1inch sells. Both regex anchors on every
pattern: without the end anchor, `quote/../../portfolio` is a quote.

The check on that is the one worth reading, because **it is unsatisfiable if its claim is false.**
[`apps/app/e2e/no-key-in-bundle.ts`](apps/app/e2e/no-key-in-bundle.ts) reads the real key out of the
environment and searches the emitted client chunks for that exact string:

```
ok    the 1inch key is in none of 585 client files under .next/static
```

Handed a string the bundle *does* contain it fails on 16 chunks, which is how we know the search
works rather than hoping it does. It refuses to run at all with no key in the environment, because a
search for an empty string passes on nothing.

**Twelve swaps, because once is not evidence.** The chat suite fills through 1inch once; one run of
it reported `+0 USDC` and could not say whether the transaction reverted, was never sent, or had not
landed. [`apps/app/e2e/oneinch-repeat.ts`](apps/app/e2e/oneinch-repeat.ts) answers the reliability
question — a fresh wallet each time, twelve sizes from $5 to about $2,500, both directions, nothing
stubbed: the route and the calldata come from the live API through our own proxy and each
transaction is signed and mined on a fork of Arbitrum One.

```
fork at 504000597, chain head 504002240, drift 1643 blocks

ok  0.01 ETH → USDC    1 tx  quoted 24.655252    got 24.668022
ok  1 ETH → USDC       1 tx  quoted 2465.479442  got 2465.479442
ok  5000 USDC → WETH   2 tx  quoted 2.015104…    got 2.012674…
…                                   12 of 12 filled at or above the floor
```

The assertion is the **floor** the card shows, not "more than zero": a fill below the minimum
computed from the quote and the slippage is a promise we did not keep, and a fill of one wei would
otherwise pass. Native ether is one transaction; a token is two, which is the approval the
aggregation API refuses to build a swap without.

#### What a live Aqua position can actually pay, which is not what its ledger says

A position was capped on Aqua's ledger alone. `pull` does `safeTransferFrom(maker, to, amount)`, so
a fill needs two more things the ledger knows nothing about: the maker's **wallet balance** and
their **allowance to Aqua**. The ledger is a number the maker shipped, and it does not fall when
they spend those tokens elsewhere or revoke the approval.

Read off Arbitrum One, three live positions with three different binding constraints:

| maker | ledger | wallet | allowance | binds on |
|---|---|---|---|---|
| `0xa9aa0af4…` | 0.0000811 WETH | 0.000209 | 0.0000018 | **allowance**, 43× short |
| `0xef9f7f40…` | 0.014624 WETH | 0 | 0 | **wallet** — a ledger with no money |
| `0xcdbde4f9…` | 0.010950 WETH | 0.010950 | unlimited | ledger, as intended |

The middle one cannot be filled at any size or any price, and nothing in Aqua's own state says so.
The cap is now `min(ledger, wallet, allowance)`, read in one multicall, and **a read that fails
counts as zero rather than as unlimited** — an RPC that will not answer is not evidence that a maker
can pay. The refusal names which of the three bound, because they need different fixes: a ledger
that binds means asking for less may work, and a wallet or an allowance that binds means no smaller
number ever will ([`aqua-swap.ts#L115-L124`](https://github.com/0xHelico/helico/blob/dc9e8bc219092093887883fcd820866e811ece0b/apps/app/lib/aqua-swap.ts#L115-L124)).

#### The account is the maker, so one capital earns and is takeable

`provide-card.tsx` ships a position backed by tokens in the **wallet**, while `supplyIdle` moves
only what the **account** holds. That is a maker beside a yield optimiser: two pools of money doing
one job each. [`provide-from-account-card.tsx`](apps/app/components/provide-from-account-card.tsx)
makes the account the maker, so one pool does both — the account holds it, the enclave puts it in
whichever market pays most, and a fill redeems exactly the shortfall on the way through.

It lands as one `executeBatch`: an approval to **Aqua** for each token and each receipt the
account holds, never to a contract of ours, and a ship. The contract's own `mandateHash` is read and compared before anything is sent, because an
encoding wrong by one field ships successfully under a hash nobody looks up. Driven through the
chat on a fork, read back out of Aqua rather than out of our own card:

```
ok  and it ships from the account in one batch  — Shipped from your account, under 0x6c833488…
ok  and Aqua records the account as the maker   — 1 Shipped event(s) from 0x0118F249…
ok  under our own Aqua app, with the ceiling on the ledger  — 20 USDC, sentinel 2
```

### The Graph

Aqua cannot answer the first question an agent has to ask.

```solidity
mapping(address maker =>
    mapping(address app =>
        mapping(bytes32 strategyHash =>
            mapping(address token => Balance)))) private _balances;

event Shipped(address maker, address app, bytes32 strategyHash, bytes strategy);
```

The mapping is `private` and four levels deep. **No event parameter is `indexed`**, so logs cannot
be filtered by maker, app or token. And `rawBalances` needs a hash you already have. So *"which
mandates does this maker have, and what is left in each?"* has **no on-chain answer at all** —
which is what makes an indexer load-bearing here rather than decorative.

The subgraph is in [`subgraph/`](subgraph/), deployed to Subgraph Studio and indexing the live
Aqua. `bun scripts/check-subgraph.ts` **measures the claim above before answering it** — it asks
the chain for `Shipped` logs and counts the topics on them:

```
Shipped logs in the last 200,000 blocks: 1
topics per log: 1–1
→ only topic0, the signature. No parameter is indexed, so logs cannot be
  filtered by maker, by app or by token. Only by "a Shipped happened".
```

If any parameter were indexed a log would carry two topics or more, and the script would say so
instead. Then it asks the subgraph the same question. Against the busiest maker on the chain —
not ours:

```
maker     0xef9f7f4006fe95afede04f6916e72556a957ebbc
mandates  54, of which 11 still active, across 5 tokens
```

Fifty-four strategies under one address (read 12 September), and no way on chain to learn any of them exist. Docked
ones come back marked docked rather than merely empty, which is Aqua's own three-state sentinel.

> **Two mistakes got it here, and one query catches both.** It indexed a real-but-wrong Aqua
> ([#165](https://github.com/0xHelico/helico/issues/165)), then deployed the fix to a Studio slug
> nobody queries ([#183](https://github.com/0xHelico/helico/pull/183)). Both times the endpoint
> answered, `hasIndexingErrors` was false, and `_meta` tracked the head. **The oldest entity an
> endpoint serves cannot predate the first log of the contract it indexes** — that is what
> separates "this endpoint is up" from "this endpoint read the contract we meant".

We also got the Aqua address wrong twice and are keeping both corrections rather than editing them
away. First we said Aqua on Arbitrum was empty, from a query asking for the last 10,000,000 blocks
when the newest event was 49 million old. Then the address itself turned out to be a different
deployment 1inch does not call Aqua. The canonical one is
`0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a`, confirmed by their SDK constant and by the deployed
router's own bytecode — not by event counts, which pick the wrong contract, or by recent event
counts, which pick the right one by luck.


**And 1inch says the same thing, which is better evidence than our saying it.** Their Aqua
documentation, under Data & Analytics:

> A hosted subgraph is not currently available. Build a reference indexer over the five
> registry/router events keyed on `(maker, app, strategyHash)`.

We indexed four of those five. `Shipped`, `Docked`, `Pulled` and `Pushed` are on the Aqua registry;
the fifth, `Swapped`, is on the router, and there was no router data source at all. There were
**340** of them at `0x111111338c…` since Aqua's deployment when the data source was written — the
most recent two minutes before the query — so it landed with 340 fills nobody could otherwise
query, and the live index serves every one since.

Its `startBlock` is the router's own first log, an `OwnershipTransferred`, so it is the deployment
and exact rather than a safe underestimate. Bisected with `eth_getLogs`, never `eth_getCode`: a
pruned archive answers *"state is not available"*, and a search that reads that as "no code yet"
returns the node's pruning boundary instead of a deployment.

**It is keyed honestly, and that is the part worth reading.** `Swapped` carries `orderHash` — the
router's identifier for the order it executed, which is *not* the `strategyHash` everything else in
the schema keys on and is not derivable from the event. So there is **no edge from `Fill` to
`Mandate`**: a join on two hashes that are not the same hash would be a lie that reads as data. The
`maker` edge is real, because the event carries the address.

| What | Where |
|---|---|
| The fifth event, and the four before it | [`subgraph/subgraph.yaml`](subgraph/subgraph.yaml) |
| A fill written as what the log carries, and nothing it does not | [`router.ts#L18-L45`](https://github.com/0xHelico/helico/blob/85fa79fa4d82f92b7f55c027c1fe2932043d716b/subgraph/src/router.ts#L18-L45) |
| Why `Fill` has no edge to `Mandate` | [`subgraph/schema.graphql`](subgraph/schema.graphql) |
| The question the chain cannot answer, asked and paged to the end | [`mandates.ts#L115-L141`](https://github.com/0xHelico/helico/blob/f6f2fc6695e030d8a6918a863470299fcb8dd179/packages/plugins/thegraph/src/mandates.ts#L115-L141) |
| A docked mandate kept distinct from an empty one | [`mandates.ts#L62-L81`](https://github.com/0xHelico/helico/blob/f6f2fc6695e030d8a6918a863470299fcb8dd179/packages/plugins/thegraph/src/mandates.ts#L62-L81) |
| What is still spendable, summed across live mandates | [`mandates.ts#L84-L94`](https://github.com/0xHelico/helico/blob/f6f2fc6695e030d8a6918a863470299fcb8dd179/packages/plugins/thegraph/src/mandates.ts#L84-L94) |
| Studio without a key, the gateway with one | [`client.ts#L59-L95`](https://github.com/0xHelico/helico/blob/f6f2fc6695e030d8a6918a863470299fcb8dd179/packages/plugins/thegraph/src/client.ts#L59-L95) |
| The accounts the enclave discovers from the index | [`subgraph.ts#L191-L205`](https://github.com/0xHelico/helico/blob/f6f2fc6695e030d8a6918a863470299fcb8dd179/packages/plugins/cre/src/subgraph.ts#L191-L205) |
| The subgraph itself | [`subgraph/`](subgraph/) |

### Uniswap v4 — real, tested, not a submitted track

The plugin talks to v4 directly, no aggregator. Every claim has an on-chain transaction behind it
on Base Sepolia, listed in [the plugin's README](packages/plugins/uniswap/README.md).
[`FEEDBACK.md`](FEEDBACK.md) records what we ran into building on their stack.

| What | Where |
|---|---|
| Universal Router `execute`, `V4_SWAP`, router-level `SWEEP` | [`swap.ts#L100-L121`](https://github.com/0xHelico/helico/blob/89054c6fe9fdb8c7cfe7b978e11f9b37a1e42c25/packages/plugins/uniswap/src/swap.ts#L100-L121) |
| `SWAP_EXACT_IN_SINGLE` and its settlement pair | [`swap.ts#L148-L170`](https://github.com/0xHelico/helico/blob/89054c6fe9fdb8c7cfe7b978e11f9b37a1e42c25/packages/plugins/uniswap/src/swap.ts#L148-L170) |
| `Quoter` read over `eth_call` | [`quote.ts#L17-L28`](https://github.com/0xHelico/helico/blob/89054c6fe9fdb8c7cfe7b978e11f9b37a1e42c25/packages/plugins/uniswap/src/quote.ts#L17-L28) |
| Pool state through `StateView` | [`pool.ts#L72-L90`](https://github.com/0xHelico/helico/blob/89054c6fe9fdb8c7cfe7b978e11f9b37a1e42c25/packages/plugins/uniswap/src/pool.ts#L72-L90) |
| `PoolId` derivation, matching v4's own | [`pool.ts#L47-L60`](https://github.com/0xHelico/helico/blob/89054c6fe9fdb8c7cfe7b978e11f9b37a1e42c25/packages/plugins/uniswap/src/pool.ts#L47-L60) |
| Addresses from the official SDK | [`addresses.ts#L99-L107`](https://github.com/0xHelico/helico/blob/89054c6fe9fdb8c7cfe7b978e11f9b37a1e42c25/packages/plugins/uniswap/src/addresses.ts#L99-L107) |
| Permit2 approval | [`approval.ts#L93-L110`](https://github.com/0xHelico/helico/blob/89054c6fe9fdb8c7cfe7b978e11f9b37a1e42c25/packages/plugins/uniswap/src/approval.ts#L93-L110) |
| EIP-712 `PermitSingle` typed data | [`approval.ts#L134-L160`](https://github.com/0xHelico/helico/blob/89054c6fe9fdb8c7cfe7b978e11f9b37a1e42c25/packages/plugins/uniswap/src/approval.ts#L134-L160) |
| `PositionManager` mint | [`liquidity.ts#L93-L124`](https://github.com/0xHelico/helico/blob/89054c6fe9fdb8c7cfe7b978e11f9b37a1e42c25/packages/plugins/uniswap/src/liquidity.ts#L93-L124) |

Every link above is a **commit-pinned permalink**, checked against the code it points at by
`scripts/check-readme-links.py` in CI — because a permalink to the wrong lines is worse than none.
It looks checked.

## Rules

We follow the ETHOnline 2026 rules. The one that matters most: **an integration that does not
genuinely work is a full disqualification**, not a deduction. Coding rules are in
[`CLAUDE.md`](CLAUDE.md); AI usage is logged in [`AI-USAGE.md`](AI-USAGE.md).

**About the history.** Judges inspect commits, so: eleven merges on `main` are squashed, made
before squash merging was switched off —
[#64](https://github.com/0xHelico/helico/pull/64),
[#65](https://github.com/0xHelico/helico/pull/65),
[#67](https://github.com/0xHelico/helico/pull/67),
[#69](https://github.com/0xHelico/helico/pull/69),
[#70](https://github.com/0xHelico/helico/pull/70),
[#72](https://github.com/0xHelico/helico/pull/72),
[#75](https://github.com/0xHelico/helico/pull/75),
[#77](https://github.com/0xHelico/helico/pull/77),
[#84](https://github.com/0xHelico/helico/pull/84),
[#98](https://github.com/0xHelico/helico/pull/98),
[#102](https://github.com/0xHelico/helico/pull/102).
Each shows as one commit rather than the work behind it — #67 was 19, #84 was 10. Nothing is lost:
the sequence is on the pull request, and the commits stay fetchable even where the branch is gone.

```
git fetch origin refs/pull/67/head    # all 19
```

Every other merge on `main` is the work as it happened.
