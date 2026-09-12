import { expect, test } from "bun:test";

import { labeller, tooltipLabel } from "@/components/price-chart";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (ms: number) => ({ timestamp: ms, value: 0 });

// Nothing here asserts a wall-clock value. The labels are in the reader's own zone, so a test
// that expected "14:00" would pass in one timezone and fail in the next. What is checked is the
// shape and, more importantly, that two nearby points are told apart.

// **The complaint this exists for.** 1D drew nine labels across twenty-four hours and wrote the
// same date under four of them, so moving the crosshair changed nothing a reader could see: the
// value holds between events and the label held too.
test("a window of a day is labelled by the hour, and nearby points differ", () => {
  const stamp = labeller([at(0), at(DAY)]);
  expect(stamp(0)).toMatch(/^\d{2}:\d{2}$/);
  expect(stamp(3 * HOUR)).not.toBe(stamp(0));
  expect(stamp(3 * HOUR)).toMatch(/^\d{2}:\d{2}$/);
});

// A week is still short enough for two labels to land on one date, so both halves are needed.
test("a window of days carries the date and the hour", () => {
  const stamp = labeller([at(0), at(5 * DAY)]);
  expect(stamp(0)).toMatch(/^\d{1,2} [A-Z][a-z]{2} \d{2}:\d{2}$/);
  expect(stamp(20 * HOUR)).not.toBe(stamp(0));
});

// Past ten days the points are days apart and the hour is noise the axis has no room for.
test("a window of a month is the date alone", () => {
  const stamp = labeller([at(0), at(30 * DAY)]);
  expect(stamp(0)).toMatch(/^\d{1,2} [A-Z][a-z]{2}$/);
  expect(stamp(0)).not.toContain(":");
});

test("a window of years is the month and the year", () => {
  const stamp = labeller([at(0), at(800 * DAY)]);
  expect(stamp(0)).toMatch(/^[A-Z][a-z]{2} \d{4}$/);
});

// The tooltip is the one place a reader can ask what a point is, and on a balance that holds its
// value for days the timestamp is the only part that changes as the crosshair moves.
test("the tooltip always carries the hour, whatever the axis chose", () => {
  expect(tooltipLabel(0)).toMatch(/^\d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2}$/);
  expect(tooltipLabel(0)).not.toBe(tooltipLabel(3 * HOUR));
});

// Day before month, and not the locale's order: an axis that reads differently depending on who
// opens the page matches the design for nobody.
test("the day comes before the month", () => {
  // 2 January, so a month-first order would put the 1 first and a day-first order the 2.
  const ts =
    Date.UTC(2026, 0, 2, 12, 0) + new Date().getTimezoneOffset() * -60_000;
  expect(tooltipLabel(ts).startsWith("2 Jan")).toBe(true);
});
