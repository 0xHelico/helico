"use client";

import type { AccountEvent } from "@/lib/activity";

/**
 * What the account was worth, over time, out of logs alone.
 *
 * **Why not simply read the balance at each past block.** Because the chain will not answer. The
 * endpoint this app reads keeps about an hour of state, and it was asked rather than assumed:
 *
 * ```
 * head - 100        answered
 * head - 100000     missing trie node
 * head - 2000000    missing trie node
 * ```
 *
 * Logs are a different matter. They are never pruned, which is why `/api/activity` can scan back to
 * the factory's deployment block. So the series is built from events, and it is exact because two
 * ledgers together account for every unit the account has ever held:
 *
 * | Side | What moves it |
 * |---|---|
 * | Liquid | every USDC transfer with the account on either end |
 * | Working | every `IdleCapitalMoved` the account emitted |
 *
 * A supply moves USDC out of the account and into a market, so the liquid side falls by exactly
 * what the working side gains and the total does not move. That is the property worth checking, and
 * `value-history.test.ts` checks it: a fold that counted the transfer without its matching move
 * would draw the account emptying itself.
 *
 * **What the line does not carry is interest still sitting in a market.** Its shape between two
 * events cannot be read without the historical state the endpoint will not serve, and drawing a
 * curve there would be a picture of an assumption. So the events carry principal, the last point is
 * the live reading, and the difference between them is the earning. Once the agent takes a position
 * back out, the extra arrives as real USDC on the liquid side and the line has it.
 */
export type ValuePoint = { timestamp: number; value: number };

/** Micro-units to a number of USDC. Six decimals, so this is exact to the cent and beyond. */
const dollars = (units: bigint) => Number(units) / 1e6;

/**
 * The running total after each dated event, then the live reading.
 *
 * Undated events are skipped rather than stacked on today. The chain fallback has no timestamps —
 * `eth_getLogs` does not carry one — so on that path this returns the live point alone and the card
 * says there is nothing to plot, which is true, rather than drawing every event at this instant.
 */
export function valueSeries(
  events: AccountEvent[],
  live: { idle: bigint; working: bigint } | null,
  now = Date.now(),
): ValuePoint[] {
  const dated = events
    .filter((e) => typeof e.at === "number")
    .sort((a, b) =>
      a.block === b.block
        ? a.key.localeCompare(b.key)
        : a.block < b.block
          ? -1
          : 1,
    );

  let liquid = 0n;
  let working = 0n;
  const points: ValuePoint[] = [];
  for (const e of dated) {
    if (e.kind === "in") liquid += e.units;
    else if (e.kind === "out") liquid -= e.units;
    else if (e.kind === "moved") working += e.into ? e.units : -e.units;
    else continue;
    const timestamp = (e.at as number) * 1000;
    // **One point per moment.** A supply is two events in one block: the USDC leaves before the
    // market is credited. Plotted separately they share an x and the line drops to the liquid
    // remainder and climbs straight back, which reads as the account briefly emptying. Nobody can
    // observe the state between two logs of one transaction, so it is not a reading.
    if (points.at(-1)?.timestamp === timestamp) points.pop();
    points.push({ timestamp, value: dollars(liquid + working) });
  }

  // The right-hand end is the number printed above the chart, not the fold's own total. They differ
  // by whatever a market has paid and nobody has taken out yet, and that gap is the profit — so it
  // belongs on the line rather than being quietly reconciled away.
  if (live)
    points.push({ timestamp: now, value: dollars(live.idle + live.working) });
  return points;
}

/**
 * The series clipped to a window, with a point at the window's left edge carrying the value as of
 * then.
 *
 * Without that edge point, choosing "7D" on an account funded a month ago would drop every event
 * and draw a flat line, as if the money had appeared this morning. `null` days means all of it.
 */
export function windowed(
  points: ValuePoint[],
  days: number | null,
  now = Date.now(),
): ValuePoint[] {
  if (days === null || points.length === 0) return points;
  const from = now - days * 86_400_000;
  const inside = points.filter((p) => p.timestamp >= from);
  if (inside.length === points.length) return points;
  const before = points.filter((p) => p.timestamp < from).at(-1);
  // Nothing before the window means the account did not exist then, which is a zero worth drawing.
  return [{ timestamp: from, value: before?.value ?? 0 }, ...inside];
}

export type Trend = "up" | "down" | "flat";

/**
 * Which way the window went, and by how much. Flat is its own answer, not a rounding of up.
 *
 * **`decimals` is what the caller is about to print**, and the threshold comes from it rather than
 * being a constant. With a fixed tenth of a cent, the account this was built against reads
 * "unchanged" beside a line that visibly steps up: sixty-five millionths of a dollar is nothing at
 * two decimals and is the whole of the earning at four. A label that contradicts the line beside it
 * is worse than either answer on its own.
 */
export function change(
  points: ValuePoint[],
  decimals = 2,
): { trend: Trend; absolute: number; percent: number | null } {
  const first = points.at(0)?.value ?? 0;
  const last = points.at(-1)?.value ?? 0;
  const absolute = last - first;
  // Half of the last digit shown: below it the two figures print identically.
  const visible = 0.5 * 10 ** -decimals;
  return {
    trend: Math.abs(absolute) < visible ? "flat" : absolute > 0 ? "up" : "down",
    absolute,
    // From nothing to something is not a percentage. A start of zero makes every gain infinite.
    percent: first === 0 ? null : (absolute / first) * 100,
  };
}
