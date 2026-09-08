import { describe, expect, test } from "bun:test";

import { amount, token } from "./mandates";

describe("naming a token", () => {
  test("known ones get their symbol and decimals", () => {
    expect(token("0xaf88d065e77c8cC2239327C5EDb3A432268e5831")).toEqual({
      symbol: "USDC",
      decimals: 6,
    });
  });

  test("case does not decide whether it is known", () => {
    expect(token("0xAF88D065E77C8CC2239327C5EDB3A432268E5831").symbol).toBe(
      "USDC",
    );
  });

  // A wrong symbol beside a real balance is worse than an address nobody recognises: the first
  // is read and believed, the second is looked up.
  test("an unknown one is shown as its address, never guessed at", () => {
    const t = token("0x1234567890123456789012345678901234567890");
    expect(t.decimals).toBeNull();
    expect(t.symbol).toBe("0x1234…7890");
  });
});

describe("showing an amount", () => {
  test("USDC has six decimals, not eighteen", () => {
    expect(amount(1_500_000n, 6)).toBe("1.5");
  });

  test("and WETH has eighteen", () => {
    expect(amount(10n ** 18n, 18)).toBe("1");
  });

  // Guessing 18 for a 6-decimal token is wrong by a factor of a trillion, and the result looks
  // like a plausible small number rather than like an error.
  test("guessing the decimals would be wrong by a trillion", () => {
    expect(amount(1_000_000n, 6)).toBe("1");
    expect(amount(1_000_000n, 18)).toBe("0");
  });

  test("an unknown token shows the integer rather than a scaled lie", () => {
    expect(amount(1_500_000n, null)).toBe("1500000");
  });

  test("zero is zero, not blank", () => {
    expect(amount(0n, 6)).toBe("0");
  });

  test("amounts far beyond a double keep every digit of the whole part", () => {
    expect(amount(99786406005223823281n, 18)).toBe("99.78");
  });
});
