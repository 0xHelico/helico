# One signature from ETH to a maker at work

12 September 2026, 17:20 UTC. Written before the code. Issue #487.

## The ask, and why it is two signatures today

A wallet that holds ETH and no USDC wants one transaction: ETH becomes USDC, the USDC becomes a
mandate on Aqua, the enclave puts it to work. The put-to-work card sizes the transfer and the
mandate from the wallet's USDC balance at plan time, which is zero before a swap lands, so the
swap card and the put-to-work card are two presses.

## What makes it one

Measured against the 1inch swap API with our key: `/swap/v6.1` takes `receiver`. Asked for
0.0004 ETH → USDC from `0x43F9ee1f…` with `receiver` = that wallet's not-yet-opened account
`0x8E0f7e67…`, it answered `dstAmount 1009074`, `value 0.0004 ETH`, gas 162,640, and the account
address in the calldata. An ERC-20 transfer to a CREATE2 address with no code is an ordinary
transfer, and `open` puts the code there in the same batch.

So the existing EIP-5792 batch gains one call:

```
open(owner)                                    unchanged
1inch swap  ETH (value) → USDC, receiver=acct  new
setAgent, permitVenue ×4                       unchanged
transfer(account, walletUSDC)                  only when the wallet holds USDC
executeBatch: approve Aqua + ship              sized by ceiling + the quote's minAmountOut
```

`minAmountOut` is the floor 1inch's own calldata enforces (`minReturn`), so the mandate names
nothing the account might not hold. Whatever lands above it is idle in the account, and since #479
the enclave moves it too.

## What it touches

- `packages/plugins/1inch/src/api.ts` — `swapTransaction` takes an optional `receiver`; the proxy
  already forwards the whole query string.
- `apps/app/lib/oneinch-swap.ts` — `planOneInchSwap` passes `receiver` through.
- `apps/app/lib/put-to-work.ts` — **new, pure**: the calls of the batch and the mandate they ship,
  from balances, permits, an optional funding swap and a salt. Tests on the shape with and without
  the swap, and that the swap's `value` is the only value in the batch.
- `apps/app/components/put-to-work-card.tsx` — a *fund from ETH* input (dollars) shown when the
  wallet's USDC is zero; the quote through `planOneInchSwap` with `receiver` = the account, refreshed
  at press time; one more line in the breakdown; the batch built by the lib.

Not touched: contracts, the enclave, the subgraph, `Interpret`, the swap card.

## What is measured before this ships

1. Plugin and app unit tests.
2. A fork of Arbitrum One: an impersonated wallet holding ETH only sends the same calls in the
   same order — the 1inch calldata from the real API with `receiver` set — and the chain is read
   back: the account has code, `agent()` is the proxy, four permits, USDC in the account equals
   the swap's output, Aqua's ledger holds the mandate at `minAmountOut`. The fork replays a batch
   non-atomically, which is the approximation `e2e/fork-put-to-work.ts` already documents.
3. Ghoza's wallet on mainnet, one press, then the enclave's next run.

## Second half, same night: the sentence says it

Ghoza: *"there should be a chat that swaps first, then puts everything to work — one sentence.
Pressing 'put all my money to work' and having it suddenly swap is an anomaly."* Right: the card
offering a swap input is the card deciding to do something the person did not say.

So the swap comes from the sentence. `Interpret`'s prompt allows `tokenIn`/`tokenOut`/amount on
`earn` when the sentence asks to swap into USDC first; the service builds that half through
`build` like any swap, refuses a swap that does not end in USDC, and answers `earn` with the
checked intent beside it. The app stores that turn as `{action: "earn", fund: intent}` and the
put-to-work card takes `fund` as a prop: the first line of the breakdown is the swap, quoted with
the account as receiver; the input is gone. Without `fund` the card never swaps.

Measured against the production model (gpt-4o-mini through the router), 12 September:
`"swap $1 of ETH to USDC and put it all to work"` → earn, ETH→USDC $1;
`"swap 0.0004 ETH and put everything to work"` → earn, ETH→USDC 0.0004;
`"put all my money to work"` → earn, no swap; `"swap $1 of ETH to USDC"` → swap.

One measurement error on the way, recorded because it cost twenty minutes: four runs "showed"
the model turning `0.0004 ETH` into `$0.4`. They were answered by a backend process left behind
by an earlier `go run` — `p.kill()` ends `go run`, not the binary it spawned — so the prompt
edits under test were never the ones answering. A fresh binary on a free port answered right the
first time. **Before blaming the model, check which process answered.**

## Third half: the ether works too

Ghoza, after the first live press: *"I want the USDC and the ETH working."* The account already
manages WETH — the enclave reads both assets and the ETH market is permitted — but nothing put
ether in. Now the sentence can: *"put $1 of ETH to work"* is earn with `tokenIn ETH, tokenOut
WETH`, and the batch wraps in the wallet (`WETH.deposit` with the value), transfers the WETH into
the account, and ships a mandate whose WETH side is the wrapped amount. A position that had only
USDC becomes two-sided, which is what `DegenerateReserves` was refusing. The enclave lends the
WETH on its next run. An empty destination is asked about, not guessed: into USDC and as ETH put
the money in different markets.

Measured on a fork against the live account as it stood (0.01 USDC idle, 0.986 in Morpho): wrap
0.000396 ETH → three calls, all success, WETH in the account, Aqua's ledger holding the mandate at
USDC 0.996487 and WETH 0.000396, 535,237 gas. Production model: `"put $1 of ETH to work"` →
earn ETH→WETH $1; `"put 0.0003 ETH to work as ETH"` → earn ETH→WETH 0.0003; the swap and plain
forms unchanged; `"put my ETH to work"` asks for an amount, because "all" has to leave gas.
