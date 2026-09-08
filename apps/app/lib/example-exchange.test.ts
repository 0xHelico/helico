import { describe, expect, test } from "bun:test";
import { parseUnits } from "viem";

import {
  EXAMPLE_INTENT,
  EXAMPLE_REPLY,
  EXAMPLE_SAID,
} from "./example-exchange";

/**
 * This file exists because the example is shown to strangers as a recording of what the product
 * actually did. A recording that has drifted from the product is worse than no example: it is a
 * claim about behaviour, on the one screen a judge sees before anything else.
 *
 * These do not prove the backend still answers this way — nothing offline can. They prove the
 * recorded numbers are consistent with each other, so a typo while transcribing cannot survive.
 */
describe("the recorded example", () => {
  test("the base units are the human amount, not a number typed twice", () => {
    expect(EXAMPLE_INTENT.amountInWei).toBe(
      parseUnits(
        EXAMPLE_INTENT.amountIn,
        EXAMPLE_INTENT.tokenIn.decimals,
      ).toString(),
    );
  });

  test("the reply is about the same swap the intent describes", () => {
    expect(EXAMPLE_REPLY).toContain(EXAMPLE_INTENT.amountIn);
    expect(EXAMPLE_REPLY).toContain(EXAMPLE_INTENT.tokenIn.symbol);
    expect(EXAMPLE_REPLY).toContain(EXAMPLE_INTENT.tokenOut.symbol);
    expect(EXAMPLE_REPLY).toContain(EXAMPLE_INTENT.chain);
  });

  test("it still says nothing has moved, which is the sentence that makes it safe to show", () => {
    expect(EXAMPLE_REPLY.toLowerCase()).toContain("nothing has moved");
  });

  test("the two tokens differ, and the sentence asked for both of them", () => {
    expect(EXAMPLE_INTENT.tokenIn.symbol).not.toBe(
      EXAMPLE_INTENT.tokenOut.symbol,
    );
    expect(EXAMPLE_SAID.toUpperCase()).toContain(
      EXAMPLE_INTENT.tokenOut.symbol,
    );
  });

  /**
   * USDC on Arbitrum One, from the backend's committed registry. Pinned here so that if the
   * recording is ever refreshed from a different environment, the diff shows an address change
   * rather than hiding it among the other fields.
   */
  test("the addresses are the ones the registry holds", () => {
    expect(EXAMPLE_INTENT.tokenOut.address).toBe(
      "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    );
    expect(EXAMPLE_INTENT.tokenIn.address).toBe(
      "0x0000000000000000000000000000000000000000",
    );
    expect(EXAMPLE_INTENT.chainId).toBe(42161);
  });
});
