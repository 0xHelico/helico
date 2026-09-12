# The value line: plotting what the account is worth, from logs alone

12 September 2026.

## What is being asked for

A profit-and-loss chart on the portfolio page, drawn in the same style as the detail chart this
app's surfaces are matched against: money on the vertical axis, a green or red line depending on
which way it went, a crosshair and a tooltip carrying a dollar figure and a date.

The card already has that chart component. `price-chart.tsx` is the port, and `portfolio-hero.tsx`
feeds it a count of movements per day because a count is what the page could source. This plan is
about sourcing the money instead.

## The obstacle, measured rather than assumed

A value line needs the account's balance at past moments. The obvious way to get one is to ask the
chain for a balance at an old block. That does not work here, and it was checked rather than
guessed:

```
head = 504338763
  -100      0x0000…079b96        (answered)
  -100000   missing trie node    (refused)
  -300000   missing trie node    (refused)
  -2000000  missing trie node    (refused)
```

`https://arb1.arbitrum.io/rpc` keeps roughly the last hour of state. Historical `eth_call` is not
available, so no amount of care in the charting code can produce a measured balance for last
Tuesday.

Logs are a different matter. They are not pruned, which is why `/api/activity` can scan back to the
factory's deployment block and why the account's whole history is already readable.

## What can be built out of logs, exactly

Two ledgers, both complete, both from events:

| Side | Source | Exact? |
|---|---|---|
| Liquid | every USDC `Transfer` with the account on either end | yes |
| Working | every `IdleCapitalMoved` the account emitted | yes, as principal |

Adding them gives the account's value at every block where something happened, and it stays correct
across a supply: USDC leaves the account and lands at the venue, so the liquid side falls by the
same amount the working side rises. The account this was checked against shows it:

```
block 504019200   +0.500081 USDC in     liquid 0.500081   working 0          total 0.500081
block 504035561   -0.490081 USDC out    liquid 0.010000   working 0.490081   total 0.500081
```

A withdrawal carries back more than was supplied, because the venue pays interest, and that extra
arrives on the liquid side as real USDC. So realised earnings are in the line without any modelling.

What is not in the line is interest still sitting in a venue. Its shape between two events cannot be
read without historical state, and drawing a smooth curve there would be a picture of an assumption.
So the series carries principal, the last point is the live reading, and the difference between them
is stated rather than drawn.

## The change

**Backend.** `apps/be/internal/activity` learns two more kinds, `in` and `out`, from USDC `Transfer`
logs filtered on the account. The table already has the columns for them, so no migration: the token
goes in `asset`, the counterparty in `pool`, the figure in `amount`, the direction in `supplied`.
The same cursor covers them, so the forward-only property is unchanged and a second read still costs
one narrow query.

Doing it here rather than in the browser is the point of the package. Two more wide `eth_getLogs`
per visitor per page load is exactly what that endpoint was built to stop.

**Frontend.** A fold over those events gives `{ timestamp, value }`. `price-chart.tsx` takes a trend
and formats money, the way the reference does. `portfolio-hero.tsx` plots value over the selected
range, with the change over that range beside the total.

The movements-per-day series is not lost. It answers a question this one does not, so it stays as a
second reading rather than being replaced.

## How it is verified

1. Go tests on the decoder: a `Transfer` in and a `Transfer` out, each asserted against the topic
   the chain actually carries, and a log whose shape does not match dropped.
2. A test on the fold: the two events above, in order, must produce a flat total across the supply.
   A fold that double counted would rise to one dollar, and a fold that missed the deposit would
   start at zero and stay there.
3. The live account read end to end, with the numbers above as the expected answer.
