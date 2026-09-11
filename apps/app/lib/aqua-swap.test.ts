import { describe, expect, it } from "bun:test";

import { fillableCap } from "./aqua-swap";

/**
 * The three numbers, read off Arbitrum One on 11 September with `rawBalances`, `balanceOf` and
 * `allowance`. Aqua's own analytics API reports the same three, which is where the question came
 * from — but these are the on-chain reads, not their answer (#393).
 */
describe("what a live Aqua position can actually pay", () => {
  it("binds on the ledger when the maker is good for it — the case we assumed was the only one", () => {
    // 0xcdbde4f9…, WETH: an unlimited approval and a wallet that covers the commitment.
    const { amount, limit } = fillableCap(
      10_950_193_415_465_793n,
      10_950_908_429_596_186n,
      2n ** 255n,
    );
    expect(limit).toBe("ledger");
    expect(amount).toBe(10_950_193_415_465_793n);
  });

  it("binds on the allowance when the approval is short of the ledger", () => {
    // 0xa9aa0af4…, WETH: the wallet holds more than the ledger says, and the allowance is 43× less.
    const { amount, limit } = fillableCap(
      81_116_404_769_890n,
      209_226_636_101_739n,
      1_889_659_104_481n,
    );
    expect(limit).toBe("allowance");
    expect(amount).toBe(1_889_659_104_481n);
  });

  it("refuses a phantom position: a ledger balance with an empty wallet", () => {
    // 0xef9f7f40…: the ledger says 0.0146 WETH is spendable and the maker holds nothing at all.
    // Nothing in Aqua's own state says so, which is why capping on the ledger offered it.
    const { amount, limit } = fillableCap(14_624_257_764_975_813n, 0n, 0n);
    expect(limit).toBe("wallet");
    expect(amount).toBe(0n);
  });

  it("blames the wallet, not the allowance, when both are zero", () => {
    // The order of the tie matters: telling somebody to raise an allowance they have already set
    // high enough sends them to fix the wrong thing.
    expect(fillableCap(5n, 0n, 0n).limit).toBe("wallet");
  });

  it("blames the ledger when all three are equal", () => {
    expect(fillableCap(7n, 7n, 7n)).toEqual({ amount: 7n, limit: "ledger" });
  });

  it("takes the smallest whichever it is", () => {
    expect(fillableCap(9n, 4n, 6n)).toEqual({ amount: 4n, limit: "wallet" });
    expect(fillableCap(9n, 6n, 4n)).toEqual({ amount: 4n, limit: "allowance" });
    expect(fillableCap(3n, 6n, 4n)).toEqual({ amount: 3n, limit: "ledger" });
  });
});
