---
title: 1inch Aqua and SwapVM
---

*Moved out of the root README on 12 September so that file stays short enough to be read. Nothing
here was rewritten: this is the same text, the same measurements and the same pinned links, in a
place a reader reaches when they want the depth rather than the claim.*

## 1inch Aqua

`HelicoMandateSwap` is an Aqua app where the strategy **is** the mandate: an expiry, a named agent
contract, and a per-token ceiling on what may leave the maker's wallet.

It is deployed on Arbitrum One at
[`0x0524a353…6041`](https://arbiscan.io/address/0x0524a353dfab33CD362593ae8e97707764Fb6041#code),
behind a proxy, alongside `HelicoOracleBoard` at
[`0xe8515af9…7d39`](https://arbiscan.io/address/0xe8515af92442A5CDa67D1F32D1c8a987ba7e7d39#code).
Both are verified as proxy **and** implementation, because verifying one leaves unverified
bytecode at the address this file names. Every deployment, including the ones these replaced and
why, is in [`docs/deployments.md`](../../docs/deployments.md).

Liquidity never enters the app or Aqua. `pull` goes maker → recipient, `push` goes taker → maker,
and a test asserts both hold zero either side of a swap. Aqua files a strategy under the hash of
bytes it never reads, so every field is enforced in our contract or nowhere. 28 tests run against
a real `Aqua` deployed in `setUp`, nothing is mocked, and every guard was cut out one at a time
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

committed  30 WETH against 10 held  ·  300%
moved      0 WETH   0 USDC
```

Three concentrated ranges on the same ten ETH. On a pool that is three positions and the capital
split three ways; here it is three ledger writes and the wallet is as full afterwards. 300% is not
leverage. `pull` ends in `safeTransferFrom` from the maker's own wallet, so whoever fills first
gets the tokens and the rest revert. Watching that is the agent's job, and it is exactly why the
subgraph is here. Pricing comes from 1inch's deployed SwapVM, not from arithmetic of ours;
[the plugin's README](../../packages/plugins/1inch/README.md) lists the three ways this can be wrong
*without reverting*, each with a test.

**And for real, with a refusal in front of each way it could go wrong.**
[`scripts/ship-maker-position.ts`](../../scripts/ship-maker-position.ts) is that sequence against Arbitrum
One rather than a fork. It ships one position and stops, because filling is the taker's action, and it
refuses to run off chain 42161, without an explicit `CONFIRM=ship`, on any of the four addresses
this repository already uses, or on a wallet that does not hold both sides. The approval it leaves
behind is for exactly the amounts shipped, not unlimited.

The rehearsal is the part worth reading.
[`scripts/rehearse-ship.ts`](../../scripts/rehearse-ship.ts) runs that script **unchanged** against a
fork, on a wallet it generates, and makes every one of those refusals fire on purpose:

```
ok    a reserved address refuses
ok    an unfunded wallet refuses
ok    and approves nothing on the way out  · 0
ok    ship moved no tokens  · 20 USDC · 0.01 WETH
ok    the shipped position quotes near the feed  · 0.5 USDC -> 0.000203967213000518 WETH @ $2451.37 vs feed $2465.60
```

The last line is the only honest test that a position is live, and the first version of it was not a
test at all: it read the quote's two returned words as one number and passed on 6.7e150 WETH. It
would have passed identically on a position mispriced by 1e12, the mistake `price.ts` exists to
prevent. Decoded properly the fill lands 0.58% under Chainlink, which is the 30bps fee plus the band
and nothing else produces that number.

### A second app, because the first one cannot quote a one-sided maker

`HelicoMandateSwap` prices as a constant product, and that is a real limit rather than a
stylistic one: **the price *is* the ratio of the two sides**, so a maker holding only USDC has no
price at all. Which is exactly the maker this product is built for. Their USDC is earning in a
lending market, and a fill is settled out of it mid-swap.

`HelicoOracleBoard` quotes that maker from a Chainlink feed, and brakes itself on Aqua's own
ledger:

```
bid = mid × (BPS − spread − skew) / BPS
ask = mid × (BPS + spread − skew) / BPS
```

Both sides shift **down** as base inventory accumulates, so selling into the board gets steadily
worse and buying the inventory back gets steadily better. Inventory is pushed home by the price
rather than by anyone watching. It is the behaviour a constant product gets for free, rebuilt on top of
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
`ForkOracleBoard.t.sol`: a one-sided maker quoting the live market, the quote bending as
inventory accumulates, the cap **refusing** rather than merely discouraging, the inventory bought
back, a **stale feed refusing the fill**, and the spread being what the maker actually earns.

Four more say the fill is paid out of the lending position rather than out of the wallet, which is
the sentence at the top of this section and was the last part of it to become true
([`ForkOracleBoardYield.t.sol`](../../contracts/test/ForkOracleBoardYield.t.sol)):

```
liquid before      500 USDC
supplied before 29,500 USDC   (earning in Aave v3)
paid to taker    2,493 USDC   ← larger than the wallet held
supplied after  27,507 USDC
```

They also pin what it refuses: a fill the wallet covers never touches the market, the shipped
receipt budget bounds what may be unwound, and **a maker carrying debt is refused**, because unwinding
collateral can liquidate them, and Aave's health checks do not run on our behalf.

`FixedPriceBoard` in `contracts/test/` is the step between the two, kept as a fixture rather than
shipped. It proves a one-sided maker *can* quote on Aqua, and then proves why a fixed price is not
enough: the price does not move however much is taken, so a moving market converts the whole
position at yesterday's number.

Until 9 September none of that could be reached from outside Solidity: nothing could encode a
`SwapMandate`, so the mandate half of this track lived entirely in Foundry.
[`packages/plugins/1inch/src/mandate.ts`](../../packages/plugins/1inch/src/mandate.ts) encodes one, and
[`scripts/check-deployed.ts`](../../scripts/check-deployed.ts) runs the whole path from TypeScript against
a fork of Arbitrum One. The encoder is held against the contract's own `mandateHash` first, because
Aqua files a position under the hash of the raw bytes and an encoding wrong by one field ships
successfully and files under a hash nobody looks up.

```
0.1 WETH → 271.98 USDC   paid from the wallet, Aave untouched
2.0 WETH → 1,758.13 USDC wanted, 728.02 idle → the position unwound to 969.88
```

That is the sentence the product is built on, measured rather than asserted: the capital that
earns is the capital the mandate spends. What is still missing is a taker on Arbitrum One.
`agent` names a contract and an EOA can never be one, so no mandate has been shipped to the live
app yet.

**Powered by SwapVM. © Degensoft Ltd 2025.** [`contracts/src/swapvm/`](../../contracts/src/swapvm/) is
a redeployment of Degensoft's `AquaSwapVMRouter` with one instruction added. Their VM, transfer
phase, Aqua accounting and every published instruction are unchanged; the addition is opcode 34,
[marked as ours](../../contracts/src/swapvm/AquaYieldCover.sol) under
[their licence](https://github.com/1inch/swap-vm/blob/main/LICENSES/SwapVM-1.1.txt), whose §4
names hackathons and whose §3.1 obligations are all met: same licence on our files, upstream
notices kept, this attribution, changes marked and dated in each docblock, and build steps in
[the runbook](../../docs/deploy-runbook.md).

Why the instruction exists: every SwapVM curve prices against `balanceOut`, and Aqua answers that
from what the maker *shipped*, a number written with no transfer and no balance check. So a maker
may commit 43,000 USDC while holding 5,000. The curve is right; what breaks is `_transferOut`,
because tokens earning yield elsewhere are not there to pull. No published instruction can close
that, because none of them has a concept of a lending market. `_aquaYieldCoverXD` unwinds exactly the
shortfall, once, inside the transaction that needs it. Measured on a fork against the canonical
Aqua, real USDC and a real Aave position
([`ForkSwapVMYieldCover.t.sol`](../../contracts/test/ForkSwapVMYieldCover.t.sol)):

```
liquid before    5,000 USDC
supplied before 38,000 USDC   (earning in Aave v3)
paid to taker    8,600 USDC   ← more than the wallet held
supplied after  34,400 USDC   (3,600 unwound mid-swap, and no more)
```

**And it composes with a concentrated band, which is the position rather than the plumbing.**
`concentrate` is 1inch's own instruction, and it adds virtual reserves so a constant product prices
inside a price range. It has no idea where the inventory is. `_aquaYieldCoverXD` has no idea it is
quoting a band. Run together they are a **concentrated liquidity position whose capital earns in
Aave between fills and is unwound only when one needs it**, and nothing in the published
instruction set expresses that
([`ForkSwapVMConcentrateCover.t.sol`](../../contracts/test/ForkSwapVMConcentrateCover.t.sol)):

```
                 with the band   without it
paid to taker    10,183 USDC      8,600 USDC
```

The right-hand column is the run above: the same account, the same trade, the band removed. One
number could not have told a working band from an absent one, which is why the file measures both.

It takes **three** instructions, and the two-instruction pairing is impossible rather than merely
worse. `concentrate` requires `amountIn == 0 || amountOut == 0`, so it runs before any swap;
`_aquaYieldCoverXD` reads `ctx.swap.amountOut` and returns when it is zero, so it runs after one.
Both failing orderings are pinned in that file beside the working one.

### A second 1inch surface: the aggregation route, for when no mandate can pay

Everything above is our own Aqua app. This is the other half of the same partner, and the reason
the product works for somebody who has not shipped a position of their own.

**Until 11 September the swap fell through to Uniswap v4 when Aqua had nothing to fill against**,
for one reason only: the aggregation API needs a key and we had none, while the v4 Quoter is an
on-chain call. So the most visible action in the product ended at a protocol we do not submit while
the partner we do submit sat behind a refusal. The chain is now:

```
Aqua  →  1inch aggregation  →  Uniswap v4
```

Aqua keeps everything it was doing. `provide` ships through it, the moment a position exists this
path takes it, and the fallbacks only run when it cannot. Uniswap stays **last** because it needs
no key and no service, so it still answers when a deployment has no 1inch key or 1inch rate-limits
us. Every tier is named in the card, because a swap that quietly changes venue reads as a claim.

| What | Where |
|---|---|
| The three tiers, and why each is where it is | [`swap-card.tsx`](../../apps/app/components/swap-card.tsx) |
| The transaction 1inch builds, and why its simulation is skipped | [`api.ts#L136-L166`](https://github.com/0xHelico/helico/blob/c2d17bbf89641ee70868891d77aab15906d360e1/packages/plugins/1inch/src/api.ts#L136-L166) |
| The plan: allowance read on chain, approval first, fill second | [`oneinch-swap.ts#L55-L132`](https://github.com/0xHelico/helico/blob/c2d17bbf89641ee70868891d77aab15906d360e1/apps/app/lib/oneinch-swap.ts#L55-L132) |
| The six shapes the proxy forwards, anchored at both ends | [`oneinch-proxy.ts#L19-L26`](https://github.com/0xHelico/helico/blob/c2d17bbf89641ee70868891d77aab15906d360e1/apps/app/lib/oneinch-proxy.ts#L19-L26) |
| Thirty a minute per caller, swept on a request rather than a timer | [`oneinch-proxy.ts#L45-L58`](https://github.com/0xHelico/helico/blob/c2d17bbf89641ee70868891d77aab15906d360e1/apps/app/lib/oneinch-proxy.ts#L45-L58) |

**The key never reaches the browser.** `NEXT_PUBLIC_` inlines a value into the client bundle, so a
prefixed key is a public key; the dapp asks `/api/1inch/…`, a route handler that adds the header.
The proxy forwards six path shapes and answers 404 for everything else, because a proxy that forwards any
path is a way for anybody to spend our quota on anything 1inch sells. Both regex anchors on every
pattern: without the end anchor, `quote/../../portfolio` is a quote.

The check on that is the one worth reading, because **it is unsatisfiable if its claim is false.**
[`apps/app/e2e/no-key-in-bundle.ts`](../../apps/app/e2e/no-key-in-bundle.ts) reads the real key out of the
environment and searches the emitted client chunks for that exact string:

```
ok    the 1inch key is in none of 585 client files under .next/static
```

Handed a string the bundle *does* contain it fails on 16 chunks, which is how we know the search
works rather than hoping it does. It refuses to run at all with no key in the environment, because a
search for an empty string passes on nothing.

**Twelve swaps, because once is not evidence.** The chat suite fills through 1inch once; one run of
it reported `+0 USDC` and could not say whether the transaction reverted, was never sent, or had not
landed. [`apps/app/e2e/oneinch-repeat.ts`](../../apps/app/e2e/oneinch-repeat.ts) answers the reliability
question: a fresh wallet each time, twelve sizes from $5 to about $2,500, both directions, nothing
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

### What a live Aqua position can actually pay, which is not what its ledger says

A position was capped on Aqua's ledger alone. `pull` does `safeTransferFrom(maker, to, amount)`, so
a fill needs two more things the ledger knows nothing about: the maker's **wallet balance** and
their **allowance to Aqua**. The ledger is a number the maker shipped, and it does not fall when
they spend those tokens elsewhere or revoke the approval.

Read off Arbitrum One, three live positions with three different binding constraints:

| maker | ledger | wallet | allowance | binds on |
|---|---|---|---|---|
| `0xa9aa0af4…` | 0.0000811 WETH | 0.000209 | 0.0000018 | **allowance**, 43× short |
| `0xef9f7f40…` | 0.014624 WETH | 0 | 0 | **wallet**, a ledger with no money |
| `0xcdbde4f9…` | 0.010950 WETH | 0.010950 | unlimited | ledger, as intended |

The middle one cannot be filled at any size or any price, and nothing in Aqua's own state says so.
The cap is now `min(ledger, wallet, allowance)`, read in one multicall, and **a read that fails
counts as zero rather than as unlimited**. An RPC that will not answer is not evidence that a maker
can pay. The refusal names which of the three bound, because they need different fixes: a ledger
that binds means asking for less may work, and a wallet or an allowance that binds means no smaller
number ever will ([`aqua-swap.ts#L115-L124`](https://github.com/0xHelico/helico/blob/dc9e8bc219092093887883fcd820866e811ece0b/apps/app/lib/aqua-swap.ts#L115-L124)).

### The account is the maker, so one capital earns and is takeable

`provide-card.tsx` ships a position backed by tokens in the **wallet**, while `supplyIdle` moves
only what the **account** holds. That is a maker beside a yield optimiser: two pools of money doing
one job each. [`provide-from-account-card.tsx`](../../apps/app/components/provide-from-account-card.tsx)
makes the account the maker, so one pool does both. The account holds it, the enclave puts it in
whichever market pays most, and a fill redeems exactly the shortfall on the way through.

It lands as one `executeBatch`: an approval to **Aqua** for each token and each receipt the
account holds, never to a contract of ours, and a ship. The contract's own `mandateHash` is read and compared before anything is sent, because an
encoding wrong by one field ships successfully under a hash nobody looks up. Driven through the
chat on a fork, read back out of Aqua rather than out of our own card:

```
ok  and it ships from the account in one batch  · Shipped from your account, under 0x6c833488…
ok  and Aqua records the account as the maker   · 1 Shipped event(s) from 0x0118F249…
ok  under our own Aqua app, with the ceiling on the ledger  · 20 USDC, sentinel 2
```
