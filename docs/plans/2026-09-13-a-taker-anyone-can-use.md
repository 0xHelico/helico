# A taker anyone can use

13 September 2026, 02:30 UTC. Written before the deploy; the code came first this time, because
the question was whether it could be done at all, and the fork answered in an hour.

## The gap

Every claim about "earning in a lending market and still takeable on Aqua" rested on fork tests
with a test contract as the taker. `HelicoMandateSwap.swapExactIn` delivers the output and then
calls the taker back to pay; solc's EXTCODESIZE check before that call means an EOA cannot take
at all, and the app's swap card only fills SwapVM strategies (#468). Nobody could take our
positions on Arbitrum One, so the sentence had never been a mainnet transaction.

## The contract

`HelicoTaker`: `take(mandate, zeroForOne, amountIn, amountOutMin, deadline)` pulls exactly
`amountIn` from the caller, calls the app with the caller as `to`, and in the callback — accepted
from the app only — approves Aqua for the amount and pushes it to the maker's ledger. It keeps no
owner, no fee, no balance between transactions, and no allowance survives a call. Deployed once,
over the live `HelicoMandateSwap`, after the deploy script has checked the app's `AQUA()` is the
Aqua it will push to.

## Measured on a fork of Arbitrum One against the live mandate `0x576c16fb…`

A wallet holding only ether: 0.0001 WETH → 0.199887 USDC. The account's idle cent was spent
first, 94,939 Morpho shares were redeemed inside the swap for the rest, Aqua's USDC ledger fell
by exactly the fill, the maker received the WETH through Aqua, and neither the taker contract nor
the app held anything afterwards. The other way, 0.2 USDC → 0.0000996 WETH, out of the idle WETH
the first fill had just paid in. Five fork tests pin it, including the callback refusing any
caller but the app.

`scripts/take-mandate.ts` is the same thing for a wallet on mainnet: it finds the mandate on the
index by hash, decodes and re-hashes the bytes, quotes with every rule applied, wraps ether when
the wallet holds none, approves exactly, takes with a floor and a deadline, and reads back what
moved.

## Order

1. Code, fork tests, script — this PR.
2. Ghoza deploys `HelicoTaker` from the deployer key and verifies it.
3. `HELICO_TAKER` written into the script and `docs/deployments.md`; the landing's contract
   count becomes ten with the taker named.
4. A wallet Ghoza tops up takes the live mandate; the receipt goes into the record and the video.
