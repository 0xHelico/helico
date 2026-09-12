import { expect, test } from "bun:test";

import { type AccountEvent, withoutVenueLegs } from "@/lib/activity";
import { change, valueSeries, windowed } from "@/lib/value-history";

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

// Choosing a short range on an older account used to drop every event and draw a flat line, as if
// the money had appeared this morning.
test("a window carries the value it started at", () => {
  const now = 10 * DAY;
  const points = [
    { timestamp: 1 * DAY, value: 5 },
    { timestamp: 9 * DAY, value: 8 },
  ];
  const week = windowed(points, 7, now);
  expect(week).toHaveLength(2);
  expect(week[0]).toEqual({ timestamp: 3 * DAY, value: 5 });
  expect(windowed(points, null, now)).toHaveLength(2);
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
