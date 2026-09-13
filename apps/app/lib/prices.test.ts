import { expect, test } from "bun:test";

import { priceAt } from "@/lib/prices";

const H = 3_600_000;

test("the price at a moment is the last reading at or before it", () => {
  const at = priceAt(
    [
      { t: 3 * H, price: 2300 },
      { t: 1 * H, price: 2100 },
      { t: 2 * H, price: 2200 },
    ],
    9999,
  );
  expect(at(2 * H)).toBe(2200); // exactly on a reading: that reading
  expect(at(2 * H + 1)).toBe(2200); // between readings: the one before, never after
  expect(at(3 * H - 1)).toBe(2200);
  expect(at(10 * H)).toBe(2300); // after the last: the last stands
  expect(at(0)).toBe(2100); // before the first: the first, as a floor
});

test("with no readings the fallback stands, so a line can always be drawn", () => {
  expect(priceAt(null, 2500)(0)).toBe(2500);
  expect(priceAt([], 2500)(1e12)).toBe(2500);
});
