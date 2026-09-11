import { describe, expect, it } from "bun:test";

import { forwards, overLimit, PER_MINUTE } from "./oneinch-proxy";

const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

describe("what the proxy forwards", () => {
  it("forwards the calls the swap card makes", () => {
    for (const path of [
      "swap/v6.1/42161/quote",
      "swap/v6.1/42161/swap",
      "swap/v6.1/42161/approve/spender",
      "swap/v6.1/42161/approve/transaction",
      `price/v1.1/42161/${WETH}`,
      `price/v1.1/42161/${WETH},${USDC}`,
      `balance/v1.2/42161/balances/${WETH}`,
    ]) {
      expect(forwards(path)).toBe(true);
    }
  });

  it("refuses everything else 1inch sells, which is most of it", () => {
    for (const path of [
      "portfolio/portfolio/v5/general/current_value",
      "history/v2.0/history/0x0/events",
      "nft/v2/byaddress",
      "traces/v1.0/chain/42161/block-trace/1",
      "web3/42161",
    ]) {
      expect(forwards(path)).toBe(false);
    }
  });

  it("refuses a path that only starts like an allowed one", () => {
    // Anchored at both ends on purpose. Without the end anchor, `quote/../../anything` is a quote.
    expect(forwards("swap/v6.1/42161/quote/extra")).toBe(false);
    expect(forwards("swap/v6.1/42161/quote/../../portfolio")).toBe(false);
    expect(forwards("x/swap/v6.1/42161/quote")).toBe(false);
  });

  it("refuses a token segment that is not a token", () => {
    expect(forwards("price/v1.1/42161/../../swap")).toBe(false);
    expect(forwards("price/v1.1/42161/notanaddress")).toBe(false);
    expect(forwards(`balance/v1.2/42161/balances/${WETH}x`)).toBe(false);
  });
});

describe("how often", () => {
  it("lets a caller through up to the limit and not past it", () => {
    const now = 1_000_000;
    for (let i = 0; i < PER_MINUTE; i++) {
      expect(overLimit("a", now)).toBe(false);
    }
    expect(overLimit("a", now)).toBe(true);
  });

  it("forgets a caller after the minute is up", () => {
    const now = 2_000_000;
    for (let i = 0; i <= PER_MINUTE; i++) overLimit("b", now);
    expect(overLimit("b", now)).toBe(true);
    expect(overLimit("b", now + 60_001)).toBe(false);
  });

  it("counts callers separately, so one visitor cannot close the door on another", () => {
    const now = 3_000_000;
    for (let i = 0; i <= PER_MINUTE; i++) overLimit("loud", now);
    expect(overLimit("loud", now)).toBe(true);
    expect(overLimit("quiet", now)).toBe(false);
  });
});
