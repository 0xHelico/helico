import { describe, expect, test } from "bun:test";
import { isIntent, isTurnAction, shortfall } from "./intent";

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

  // The backend decides the action and only ever sends the ones it checked. A name that arrived
  // from anywhere else must not reach a card — this is the second place that is enforced.
  //
  // `withdraw` was on this list until it became real. A refusal list is the one kind of list that
  // goes stale silently in the *safe* direction first — the guard kept working, the test simply
  // described a world with three actions in it. Kept as a list rather than derived from
  // `isTurnAction`, because a test that computes its expectation from the code under test agrees
  // with that code however wrong it is.
  test("an action the backend never sends is refused", () => {
    for (const action of ["drain", "transfer", "swap", "sweep", "approve", ""]) {
      expect(isTurnAction({ action })).toBe(false);
    }
  });

  test("and every action it does send is accepted", () => {
    for (const action of ["status", "revoke", "withdraw"]) {
      expect(isTurnAction({ action })).toBe(true);
    }
  });
});

describe("shortfall", () => {
  test("is null while the balance is unknown, so nothing is refused on missing data", () => {
    expect(shortfall(undefined, 5n)).toBeNull();
  });
  test("is null when the balance covers it, exactly included", () => {
    expect(shortfall(5n, 5n)).toBeNull();
    expect(shortfall(6n, 5n)).toBeNull();
  });
  test("is the difference when it does not", () => {
    expect(shortfall(2n, 5n)).toBe(3n);
  });
});
