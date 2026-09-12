import { describe, expect, test } from "bun:test";

import {
  amount,
  appName,
  collapse,
  type MandateRow,
  type Movement,
  shipped,
  token,
} from "./mandates";

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
 * The table named a **superseded** `HelicoMandateSwap` — `docs/deployments.md:748` records it and
 * `:688` says the current pair supersedes it — so the mandate shipped on the 12th rendered as a
 * hex prefix in the panel whose job is naming it. The name now comes from
 * `@helico/plugin-1inch`, and this asserts the two agree.
 *
 * The second test is the one that matters on a superseded address: it is still on chain and still
 * ours, so "is it deployed" cannot be the question. "Is it the one to ship to" is.
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

/**
 * One `ship` emits a `Pushed` per token the mandate names — seven for this account's, four of
 * them the same 1497196 and three of them zero. One row per event says six USDC moved when one
 * did, so the group collapses to the movement of money it actually is.
 */
describe("collapsing movements into what moved", () => {
  const USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
  const AUSDC = "0x724dc807b04555b71ed48a6896b6f41593b8c637";
  const MORPHO = "0xbba798a61f0d7d1ae51466fd4045cd2ea25c9a29";
  const WETH = "0x82af49447d8a07e3bd95bd0d56f35241523fbab1";
  const TX =
    "0x2ed147cfe956fe5f8fc9693acdcd3af2bbd8ce8b8ec3b5669cf5bbb9f219416c";

  const push = (token: string, amount: bigint, tx = TX): Movement => ({
    at: 1_789_221_267,
    direction: "PUSH",
    token,
    amount,
    tx,
  });

  // The live ship, as the index actually serves it.
  const ship = [
    push(USDC, 1_497_196n),
    push(WETH, 0n),
    push(AUSDC, 1_497_196n),
    push(MORPHO, 1_497_196n),
  ];

  test("one ship is one row, not one per token", () => {
    expect(collapse(ship)).toHaveLength(1);
  });

  // Four rows of 1497196 for one movement of 1497196 reads as four times the money.
  test("the row is the amount that moved, once", () => {
    expect(collapse(ship)[0].amount).toBe(1_497_196n);
  });

  // At equal amounts the receipts and the asset are the same claim; the asset is the money.
  test("a base token wins a tie against a receipt", () => {
    expect(collapse(ship)[0].token).toBe(USDC);
    expect(collapse([push(AUSDC, 1n), push(USDC, 1n)])[0].token).toBe(USDC);
  });

  // A token the mandate names with nothing behind it is not something that happened.
  test("a push of nothing is not a row", () => {
    expect(collapse([push(WETH, 0n)])).toHaveLength(0);
  });

  // A fill paid out of a lending position is both at once, and hiding the outbound half would
  // turn money leaving into money arriving.
  test("a pull and a push in one transaction stay two rows", () => {
    const rows = collapse([
      push(USDC, 500n),
      { ...push(USDC, 500n), direction: "PULL" },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.direction).sort()).toEqual(["PULL", "PUSH"]);
  });

  // Found by breaking the rule and watching every test stay green: the fixture above has four
  // equal amounts, so `m.amount > held.amount` never fired and nothing covered it. A group whose
  // amounts differ is the case that needs it — a receipt unwound for slightly more than the asset
  // side, where keeping the first would understate what moved.
  test("the largest in the group wins, whichever order it arrives in", () => {
    expect(collapse([push(AUSDC, 490_158n), push(MORPHO, 7n)])[0].amount).toBe(
      490_158n,
    );
    expect(collapse([push(MORPHO, 7n), push(AUSDC, 490_158n)])[0].amount).toBe(
      490_158n,
    );
  });

  // And the tiebreak must not beat a genuinely larger receipt amount: USDC is preferred at equal
  // amounts, not at any amount.
  test("a base token does not win against a larger receipt", () => {
    expect(collapse([push(USDC, 1n), push(AUSDC, 999n)])[0].token).toBe(AUSDC);
  });

  test("two separate ships stay two rows", () => {
    expect(
      collapse([...ship, push(USDC, 7n, `${TX.slice(0, 64)}ff`)]),
    ).toHaveLength(2);
  });
});
