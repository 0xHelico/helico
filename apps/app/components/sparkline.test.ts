import { describe, expect, test } from "bun:test";

import { byDay } from "./sparkline";

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
