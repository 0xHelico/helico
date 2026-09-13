import { expect, test } from "bun:test";

import { type AccountEvent, withoutVenueLegs } from "@/lib/activity";
import {
  change,
  holdings,
  sample,
  sampleHoldings,
  valueSeries,
} from "@/lib/value-history";

const DAY = 86_400_000;

/** The two events the live account actually carries, with their real blocks and figures. */
const event = (
  kind: AccountEvent["kind"],
  units: bigint,
  block: number,
  at: number,
  into = false,
): AccountEvent => ({
  kind,
  units,
  into,
  key: `${block}-0`,
  what: "",
  amount: "",
  where: "",
  block: BigInt(block),
  at,
  tx: `0x${block.toString(16)}`,
});

const DEPOSIT = event("in", 500_081n, 504_019_200, 1_757_000_000, true);
const LEG = event("out", 490_081n, 504_035_561, 1_757_100_000);
const MOVED = event("moved", 490_081n, 504_035_561, 1_757_100_000, true);

// **A move in another asset is not a point on this line.** The first ether move — 397 trillion
// wei of WETH supplied to Compound — went through the fold as USDC micro-units and drew a $397
// million spike on a two-dollar account. The line is USDC; the WETH side is priced in the headline.
test("a WETH move does not touch the USDC line", () => {
  const wethMove: AccountEvent = {
    ...event("moved", 397_329_897_688_090n, 504_497_103, 1_757_200_000, true),
    asset: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
  };
  const usdcMove: AccountEvent = {
    ...MOVED,
    asset: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
  };
  // Without a price the ether side is left out rather than mis-scaled…
  const series = valueSeries([DEPOSIT, LEG, usdcMove, wethMove], null);
  expect(series.at(-1)?.value).toBeCloseTo(0.500081, 6);
  // …and with one, the line carries it at that price: 0.000397 WETH at $2,500 is $0.99.
  const priced = valueSeries(
    [DEPOSIT, LEG, usdcMove, wethMove],
    null,
    Date.now(),
    {
      price: 2500,
      total: 397_329_897_688_090n,
    },
  );
  expect(priced.at(-1)?.value).toBeCloseTo(0.500081 + 0.9933, 3);
  // The live point uses what the account holds now, not the fold's running total.
  const withLive = valueSeries(
    [DEPOSIT, LEG, usdcMove],
    { idle: 10_000n, working: 490_081n },
    Date.now(),
    {
      price: 2500,
      total: 500_000_000_000_000n,
    },
  );
  expect(withLive.at(-1)?.value).toBeCloseTo(0.500081 + 1.25, 3);
  // A move with no asset named — an older stored event — still counts, as it always did.
  expect(valueSeries([DEPOSIT, LEG, MOVED], null).at(-1)?.value).toBeCloseTo(
    0.500081,
    6,
  );
});

// **The property worth having.** Supplying to a market moves USDC out of the account and the total
// must not move with it. A fold that counted the transfer and forgot its matching move would draw
// the account emptying itself into Morpho.
test("a supply does not change what the account is worth", () => {
  const series = valueSeries([DEPOSIT, LEG, MOVED], null);
  // Two points, not three. The transfer and the move are one transaction in one block, and the
  // state between them is not something anyone can observe: plotted separately the line drops to
  // the liquid remainder and climbs straight back, reading as the account briefly emptying.
  expect(series.map((p) => p.value)).toEqual([0.500081, 0.500081]);
});

test("the last point is the live reading, not the fold's own total", () => {
  const series = valueSeries([DEPOSIT, LEG, MOVED], {
    idle: 10_000n,
    working: 490_300n,
  });
  // The market has paid 219 micro-units that nobody has taken out. That gap is the profit and it
  // belongs on the line.
  expect(series.at(-1)?.value).toBeCloseTo(0.5003, 6);
  expect(series).toHaveLength(3);
});

test("events with no date are skipped rather than stacked on today", () => {
  const undated = { ...DEPOSIT, at: null };
  expect(valueSeries([undated], null)).toHaveLength(0);
  expect(valueSeries([undated], { idle: 10_000n, working: 0n })).toHaveLength(
    1,
  );
});

// **The axis is evenly spaced and the events are not.** Plotted one event per x-step, two moves an
// hour apart sit as far apart as two a fortnight apart, and the dates written under them say
// otherwise. Resampling puts each reading where its timestamp belongs.
test("the window is walked at a fixed interval, not once per event", () => {
  const now = 10 * DAY;
  const points = [
    { timestamp: 1 * DAY, value: 5 },
    { timestamp: 9 * DAY, value: 8 },
  ];
  const week = sample(points, 7, now, 8);
  expect(week).toHaveLength(8);
  // Evenly spaced in time, ending exactly at now.
  expect(week.at(0)?.timestamp).toBe(3 * DAY);
  expect(week.at(-1)?.timestamp).toBe(now);
  // And a balance holds its value between changes: 5 until day 9, then 8.
  expect(week.map((p) => p.value)).toEqual([5, 5, 5, 5, 5, 5, 8, 8]);
});

// Choosing a short range on an older account must not drop every event and draw a flat nothing:
// the account was worth something a week ago and the line has to start there.
test("a window that contains no event still starts at what it was worth", () => {
  const now = 30 * DAY;
  const week = sample([{ timestamp: 1 * DAY, value: 5 }], 7, now, 4);
  expect(week.map((p) => p.value)).toEqual([5, 5, 5, 5]);
});

// Before the first reading the account did not exist. Carrying the first figure backwards would
// draw money it never had, which is what a long range on a young account would show.
test("there is nothing before the first reading", () => {
  const now = 100 * DAY;
  const funded = [{ timestamp: 74 * DAY, value: 7 }];
  expect(sample(funded, 100, now, 5).map((p) => p.value)).toEqual([
    0, 0, 0, 7, 7,
  ]);
  // ALL starts at the first reading instead, so there is no empty run to scroll past.
  expect(sample(funded, null, now, 3).map((p) => p.value)).toEqual([7, 7, 7]);
});

test("a change of nothing is flat, and a start of nothing has no percentage", () => {
  expect(
    change([
      { timestamp: 0, value: 2 },
      { timestamp: 1, value: 2 },
    ]).trend,
  ).toBe("flat");
  // **The threshold is whatever the caller prints.** The live account earned 65 millionths of a
  // dollar, which is nothing at two decimals and the whole of the earning at four. Called flat while
  // the line beside it steps up, the label contradicts the chart.
  const tiny = [
    { timestamp: 0, value: 0.500081 },
    { timestamp: 1, value: 0.500146 },
  ];
  expect(change(tiny, 2).trend).toBe("flat");
  expect(change(tiny, 4).trend).toBe("up");
  expect(
    change([
      { timestamp: 0, value: 0 },
      { timestamp: 1, value: 5 },
    ]).percent,
  ).toBeNull();
  const up = change([
    { timestamp: 0, value: 4 },
    { timestamp: 1, value: 5 },
  ]);
  expect(up.trend).toBe("up");
  expect(up.percent).toBeCloseTo(25, 6);
});

// The transfer that carries a supply out of the account is the other half of the move beside it.
// Both are needed to say what the account is worth; only one is a thing a person did.
test("the mechanical half of a supply is not a row somebody reads", () => {
  const rows = withoutVenueLegs([DEPOSIT, LEG, MOVED]);
  expect(rows.map((r) => r.kind)).toEqual(["in", "moved"]);
  // And the fold still gets both, or the total would fall by the amount supplied.
  expect(valueSeries([DEPOSIT, LEG, MOVED], null).at(-1)?.value).toBe(0.500081);
});

// The pairing is by transaction and figure, not by counterparty: Aave pulls to its receipt token
// rather than to the pool its event names, so a list of market addresses would miss that leg and
// show it. A withdrawal to the owner shares no transaction with a move and must survive.
test("a transfer that pairs with nothing stays", () => {
  const sweep = event("out", 500_000n, 504_100_000, 1_757_200_000);
  expect(withoutVenueLegs([MOVED, sweep]).map((r) => r.kind)).toEqual([
    "moved",
    "out",
  ]);
  // Same amount, different transaction: still not the leg of that move.
  const elsewhere = { ...LEG, tx: "0xff" as `0x${string}`, key: "9-0" };
  expect(withoutVenueLegs([MOVED, elsewhere])).toHaveLength(2);
});

// **The line moves with ether between events.** Ether held across a day when the price doubled
// is an account worth twice as much at the end of it, and nothing in the account's own log says
// so — the log has no event for "the market moved". Valued at each sample's own price the rise is
// drawn; valued at today's price along the whole line it is a flat line at the final figure.
test("the same ether draws a rise when its price rose", () => {
  const now = 10 * DAY;
  const wethMove: AccountEvent = {
    ...event("moved", 1_000_000_000_000_000_000n, 1, (8 * DAY) / 1000, true),
    asset: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
  };
  const held = holdings(
    [wethMove],
    { idle: 0n, working: 0n },
    now,
    1_000_000_000_000_000_000n,
  );
  // One ether, lent on day 8 and still there. Its price went from $2,000 on day 8 to $4,000 now.
  const price = (at: number) => (at < 9 * DAY ? 2000 : 4000);
  const line = sampleHoldings(held, 2, price, now, 5);
  // Samples at day 8, 8.5, 9, 9.5, 10: nothing yet, then $2,000 twice, then $4,000 twice —
  // and the first sample sits exactly on the move, which counts as held.
  expect(line.map((p) => p.value)).toEqual([2000, 2000, 4000, 4000, 4000]);
  // The same holdings at one price are flat, which is the line this replaces.
  expect(
    sampleHoldings(held, 2, () => 4000, now, 5).map((p) => p.value),
  ).toEqual([4000, 4000, 4000, 4000, 4000]);
  // And USDC is untouched by the price of ether. (The deposit carries a real 2026 timestamp,
  // so "now" for this one is the day after it.)
  const later = (DEPOSIT.at as number) * 1000 + DAY;
  const usdc = holdings([DEPOSIT], { idle: 500_081n, working: 0n }, later);
  expect(
    sampleHoldings(usdc, 1, () => 99_999, later, 3).map((p) => p.value),
  ).toEqual([0.500081, 0.500081, 0.500081]);
});
