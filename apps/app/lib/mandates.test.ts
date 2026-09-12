import { describe, expect, test } from "bun:test";

import { amount, appName, type MandateRow, shipped, token } from "./mandates";

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

/**
 * The card that ships used to remember by `useSendCalls` state, so a reload offered `Execute`
 * over a position that already existed — and pressing it shipped a second mandate under a fresh
 * salt. These are the four answers that decide the button.
 */
describe("has this maker already shipped", () => {
  const MANDATE_SWAP = "0x0524a353dfab33CD362593ae8e97707764Fb6041";
  const SWAP_VM = "0xb8c9f14d46bf387a6d70d796df30f11a0eb8c3be";

  const row = (over: Partial<MandateRow> = {}): MandateRow => ({
    strategyHash: "0x01f61bb86e3fe1b4417aa8347dc13b22faa30fce6b1446c70188",
    app: MANDATE_SWAP,
    active: true,
    movements: 0,
    balances: [],
    ...over,
  });

  test("nothing shipped is not shipped", () => {
    expect(shipped([], MANDATE_SWAP)).toEqual({ count: 0, hash: undefined });
  });

  test("a live mandate on this app counts, and carries its hash", () => {
    const answer = shipped([row()], MANDATE_SWAP);
    expect(answer.count).toBe(1);
    expect(answer.hash).toBe(row().strategyHash);
  });

  // The address the subgraph stores is lower-case; the one the plugin returns is checksummed.
  // Comparing them raw is a card that never ticks against a position that plainly exists.
  test("case does not decide it", () => {
    expect(
      shipped([row({ app: MANDATE_SWAP.toLowerCase() })], MANDATE_SWAP).count,
    ).toBe(1);
  });

  // A real position, and not this card's. Ticking on it would report work nobody did.
  test("a mandate on another app does not count", () => {
    expect(shipped([row({ app: SWAP_VM })], MANDATE_SWAP).count).toBe(0);
  });

  // Docked, or past its expiry. Both arrive as `active: false`, and a tick on either says a
  // position exists when it does not.
  test("an inactive mandate does not count", () => {
    expect(shipped([row({ active: false })], MANDATE_SWAP).count).toBe(0);
  });
});

/**
 * `HelicoMandateSwap` went behind a proxy on 10 September and this table stayed on the address
 * before it, so the mandate shipped on the 12th rendered as a hex prefix in the panel whose job
 * is naming it. The name now comes from `@helico/plugin-1inch`, and this asserts the two agree.
 */
describe("naming an Aqua app", () => {
  test("the live HelicoMandateSwap is named, not shown as hex", () => {
    expect(appName("0x0524a353dfab33CD362593ae8e97707764Fb6041")).toBe(
      "HelicoMandateSwap",
    );
  });

  test("the superseded address is not named as if it were live", () => {
    expect(appName("0xa16d313816247628deb7d89dc7a3cf4adb5287ed")).toBeNull();
  });
});
