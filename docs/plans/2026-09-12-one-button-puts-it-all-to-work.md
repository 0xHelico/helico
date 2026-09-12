# One button puts it all to work

12 September 2026.

## What is being asked for

Somebody types *"put all my asset to work"* and gets a breakdown and a single **Execute**. Pressing
it arms the account, funds it, ships a maker position on 1inch Aqua, and leaves the capital
earning. No three-card sequence, no separate trip to the limits page.

## Why this is a composition rather than a new mechanism

Every piece is already built and already proven. What has never existed is one caller for all of
them.

| Piece | Where it is | Who must be `msg.sender` |
|---|---|---|
| `open`, `setAgent`, `permitVenue` | `hooks/use-unlock.ts` | the **owner** |
| moving USDC into the account | a plain ERC-20 transfer | the **owner** |
| approvals and `ship` | `mandateSetupCalls` in `@helico/plugin-1inch` | the **account** |
| supplying to the market that pays most | the enclave, on its next run | the **agent** |

The third row is why this cannot be one `executeBatch`: that runs each call as the account, and the
account cannot administer itself — `setAgent` reverts on `msg.sender != owner()`, measured on a
fork in #289.

**EIP-5792 is what makes one press possible.** `sendCalls` batches at the wallet, so every call in
it keeps the owner as `msg.sender`: the setters pass, the transfer passes, and the ship goes
through `account.executeBatch(...)`, which is owner-gated and runs its inner calls as the account.
One confirmation, four kinds of call.

A wallet without EIP-5792 gets told so and pointed at the controls that do the same job one
transaction at a time. That path is not a failure and must not be dressed as one.

## What the breakdown says, and what it must not claim

Four lines, each either something this press does or something it does not:

1. **Arm the account** — name the agent, allow every market. Skipped when already done.
2. **Move USDC in** — the wallet's balance, all of it. Skipped when the wallet holds none.
3. **Ship the position** — a ceiling on 1inch Aqua, backed by what the account holds.
4. **Put it to work** — *the agent does this*, within minutes, into whichever market pays most.

Line 4 is the one to be careful about. This press does not supply anything, and a breakdown that
implied it would be describing a transaction that is not in the batch. The reason it is a line at
all is that the same capital is doing both jobs: `AquaYieldCover` redeems exactly the shortfall out
of the lending position when a taker fills, so shipping and earning are not a split of the money
but two claims on the whole of it. Saying "the agent does this" is both true and the product.

## The venue list is every market, not the permitted ones

`readVenues` derives permitted venues from `VenuePermitted` logs. Read before the batch, a fresh
account has none — so a mandate built from that list would name no venues at all, and a fill could
only be paid out of idle tokens. Since the same batch permits every market, the mandate names every
market: by the time anyone can fill, the permits are on chain. The existing card already says this
in a comment for a different reason — *"the enclave may have moved money there by the time somebody
fills"*.

## How it is verified

Nothing here is believed until a fork says so, because this moves money.

1. A fork of Arbitrum One, a generated wallet funded with real USDC from a real holder.
2. The button pressed through the interface, not the mutation called directly.
3. Read from the **chain** afterwards, never from the screen: `isOpen`, `agent`, `permittedVenue`
   for each market, the account's USDC balance, and Aqua's own `balances` for the shipped ledger.
4. The mandate hash the app encodes checked against the contract's own `mandateHash` before
   sending, which the existing card already does — an encoding wrong by one field ships
   successfully under a hash nobody looks up.
