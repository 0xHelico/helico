import type { Address } from "viem";

/** What `apps/be` returns once it has checked a sentence against its token registry. */
export type IntentToken = {
  symbol: string;
  address: Address;
  decimals: number;
  name: string;
};

export type Intent = {
  chainId: number;
  chain: string;
  tokenIn: IntentToken;
  tokenOut: IntentToken;
  /** Human amount, as the person said it. */
  amountIn: string;
  /** The same amount in the token's smallest unit, which is what gets signed. */
  amountInWei: string;
};
