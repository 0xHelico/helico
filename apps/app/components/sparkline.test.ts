import { describe, expect, test } from "bun:test";

import { byDay, windowDays } from "./sparkline";

const _DAY = 86_400;
/** Noon by default. Pass a time when the test is about the time. */
const at = (iso: string, hhmm = "12:00") =>
  Math.floor(Date.parse(`${iso}T${hhmm}:00Z`) / 1000);

describe("bucketing movements into days", () => {
  test("nothing is an empty series, not a series of zeroes", () => {
    expect(byDay([])).toEqual([]);
  });

  test("two on the same day are one bucket of two", () => {
    const d = byDay([at("2026-08-01"), at("2026-08-01") + 60]);
    expect(d).toHaveLength(1);
    expect(d[0]).toEqual({ date: "2026-08-01", count: 2 });
  });

  // A gap drawn as a straight line between two busy days says the quiet days did not happen.
  // Zero-filling is what makes a quiet week read as quiet.
  test("a gap is filled with zeroes rather than skipped", () => {
    const d = byDay([at("2026-08-01"), at("2026-08-05")]);
    expect(d.map((x) => x.count)).toEqual([1, 0, 0, 0, 1]);
  });

  test("the last day is included, not dropped by the loop", () => {
    const d = byDay([at("2026-08-01"), at("2026-08-02")]);
    expect(d.at(-1)).toEqual({ date: "2026-08-02", count: 1 });
  });

  // The bug this replaces, and the reason the test above could not see it: stepping 86,400
  // seconds from the first timestamp lands *before* the last one whenever the range opens later
  // in the day than it closes, and the final day silently vanishes. Every fixture above is
  // pinned to noon, which makes that impossible to express.
  test("and still included when the range opens late and closes early", () => {
    const d = byDay([at("2026-08-01", "20:00"), at("2026-08-03", "03:00")]);
    expect(d.map((x) => x.date)).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
    ]);
    expect(d.at(-1)?.count).toBe(1);
  });

  test("order in does not decide order out", () => {
    const d = byDay([at("2026-08-03"), at("2026-08-01")]);
    expect(d.map((x) => x.date)).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
    ]);
  });

  // Aqua's oldest movement is months back. Without the cap, one stale timestamp would draw
  // thousands of points into 480 pixels and take the page with it.
  test("a very long range is capped rather than drawn point by point", () => {
    const d = byDay([at("2020-01-01"), at("2026-08-01")]);
    expect(d.length).toBeLessThanOrEqual(401);
  });

  test("every bucket is a date and a count, in order", () => {
    const d = byDay([at("2026-08-01"), at("2026-08-02"), at("2026-08-02")]);
    expect(d).toEqual([
      { date: "2026-08-01", count: 1 },
      { date: "2026-08-02", count: 2 },
    ]);
  });
});

describe("windowDays", () => {
  // The bug it was written for: two events two days apart drew two points on an axis labelled
  // thirty days, which reads as a chart with no data rather than as a quiet month.
  test("walks the window, not the span of the data", () => {
    const today = new Date().toISOString().slice(0, 10);
    const days = windowDays([at(today) + 3600], 30);
    expect(days).toHaveLength(30);
    expect(days.at(-1)).toEqual({ count: 1, date: today });
    expect(days.filter((d) => d.count === 0)).toHaveLength(29);
  });

  test("is all zeroes when nothing happened, and still fills the window", () => {
    expect(windowDays([], 7)).toHaveLength(7);
    expect(windowDays([], 7).every((d) => d.count === 0)).toBe(true);
  });

  test("counts several events on one day once per event", () => {
    const today = new Date().toISOString().slice(0, 10);
    const days = windowDays([at(today), at(today) + 60, at(today) + 120], 7);
    expect(days.at(-1)?.count).toBe(3);
  });

  test("drops what falls outside the window rather than stacking it on the edge", () => {
    const today = new Date().toISOString().slice(0, 10);
    const days = windowDays([at(today) - 40 * 86_400], 7);
    expect(days.every((d) => d.count === 0)).toBe(true);
  });

  // `null` means "all of it", and there the span of the data is the right window.
  test("falls back to the data's own span for ALL", () => {
    expect(windowDays([at("2026-08-01"), at("2026-08-05")], null)).toHaveLength(
      5,
    );
  });
});
