import type { Intent } from "@/lib/intent";

/**
 * One real exchange, recorded so the gate can show what the app does to somebody who has not
 * connected a wallet.
 *
 * **Recorded, not written.** Every value below is the verbatim response of
 * `POST https://api.helico.site/api/swap/intent` to the sentence in `said`, on 7 September 2026 —
 * including the addresses, which come from the backend's committed registry rather than from a
 * model. Nothing here is illustrative in the sense of being made up, which is the only reason it
 * is honest to show it.
 *
 * **What it deliberately is not.** It is not a quote, because a quote is a price and this one is
 * hours old. It is not a position, an account, or a transaction. The panel that renders it says
 * so; if that ever stops being said, this file should stop existing.
 */
export const EXAMPLE_RECORDED_ON = "7 September 2026";

export const EXAMPLE_SAID = "Swap half an ETH into USDC";

export const EXAMPLE_REPLY =
  "Swapping 0.5 ETH into USDC on Arbitrum One. Nothing has moved: this is what I understood, and you sign it yourself.";

export const EXAMPLE_INTENT: Intent = {
  chainId: 42161,
  chain: "Arbitrum One",
  tokenIn: {
    symbol: "ETH",
    address: "0x0000000000000000000000000000000000000000",
    decimals: 18,
    name: "Ether",
  },
  tokenOut: {
    symbol: "USDC",
    address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    decimals: 6,
    name: "USD Coin",
  },
  amountIn: "0.5",
  amountInWei: "500000000000000000",
};
