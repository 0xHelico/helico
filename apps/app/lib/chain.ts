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

/**
 * An address's page on the same explorer.
 *
 * From the chain's own `blockExplorers` rather than a second hard-coded host, so a chain the
 * registry does not carry returns nothing and the caller renders plain text instead of a link to
 * somewhere that does not exist.
 */
export const explorerAddress = (
  chainId: number,
  address: string,
): string | undefined => {
  const base = networkByChainId(chainId)?.chain.blockExplorers?.default.url;
  return base ? `${base.replace(/\/$/, "")}/address/${address}` : undefined;
};
