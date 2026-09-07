import { networkByChainId } from "@helico/plugin-uniswap";

/**
 * How far the fill may fall below the quote before the swap reverts instead. Shown on every
 * card rather than hidden in a settings panel: it is the only number that decides whether a
 * bad price is refused or accepted.
 */
export const SLIPPAGE_BPS = 50;

/** A transaction's page on the chain's own explorer, from the plugin's network registry. */
export const explorerTx = (chainId: number, hash: string): string | undefined =>
  networkByChainId(chainId)?.explorerTx(hash);
