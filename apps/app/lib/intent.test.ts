import { describe, expect, test } from "bun:test";
import { isIntent, isTurnAction } from "./intent";

// One field on a message holds two different things, and the chat picks a card from it. Getting
// this wrong renders a swap card for a revoke, which offers a transaction nobody asked for.
describe("telling a stored turn's two shapes apart", () => {
  const swap = {
    chainId: 42161,
    chain: "Arbitrum One",
    tokenIn: { symbol: "ETH", address: "0x0", decimals: 18, name: "Ether" },
    tokenOut: { symbol: "USDC", address: "0x1", decimals: 6, name: "USD Coin" },
    amountIn: "0.5",
    amountInWei: "500000000000000000",
  };

  test("a swap is an intent and not an action", () => {
    expect(isIntent(swap)).toBe(true);
    expect(isTurnAction(swap)).toBe(false);
  });

  test("an action is an action and not an intent", () => {
    for (const action of ["status", "revoke"]) {
      expect(isTurnAction({ action })).toBe(true);
      expect(isIntent({ action })).toBe(false);
    }
  });

  test("nothing else is either", () => {
    for (const value of [
      null,
      undefined,
      {},
      "revoke",
      0,
      [],
      { action: "" },
    ]) {
      expect(isIntent(value)).toBe(false);
      expect(isTurnAction(value)).toBe(false);
    }
  });

  // The backend decides the action and only ever sends the three it checked. A name that arrived
  // from anywhere else must not reach a card — this is the second place that is enforced.
  test("an action the backend never sends is refused", () => {
    for (const action of ["drain", "withdraw", "transfer", "swap"]) {
      expect(isTurnAction({ action })).toBe(false);
    }
  });
});
