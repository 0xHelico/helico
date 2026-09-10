"use client";

import type { Address, PublicClient } from "viem";
import { parseAbi, parseAbiItem } from "viem";

/**
 * Every place an account's money can be, worked out from the account's own history rather than
 * from a list somebody remembered to update.
 *
 * **Why this is not a constant.** `escape` sweeps the tokens it is handed and no others — it has
 * to, because a contract cannot enumerate what it holds and a stored list could be padded with
 * dust by a stranger until the loop costs more gas than the money is worth. That design is right.
 * What was wrong was the caller: the app passed two addresses it had typed out, so an account
 * whose capital had moved to Compound swept the USDC it happened to still hold, reported success,
 * and left the rest behind.
 *
 * Adding the other five addresses would have fixed today and broken again on the next venue.
 * These are derived instead:
 *
 *   1. `VenuePermitted(address indexed pool, bool allowed)` gives every market this owner has ever
 *      allowed — from the account's own logs, no index and no constant.
 *   2. Each market is asked which receipt it issues, which is how the rest of this codebase does
 *      it: a receipt is a contract the owner named, so anything it says about itself is something
 *      the owner could have got wrong.
 *
 * A venue deployed after this file was written, permitted by the owner, is swept without anything
 * here changing.
 */

/** The assets an account is expected to hold. Owner-declared and small, unlike the venue list. */
export const ACCOUNT_ASSETS: readonly Address[] = [
  "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // USDC
  "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", // WETH
];

/**
 * The markets to fall back to when the log query cannot be made.
 *
 * A partial sweep beats none, but only if it is not silent — `readVenues` reports which way it
 * got its list so the caller can say so. Aave first because it is the one every account permits.
 */
export const KNOWN_VENUES: readonly Address[] = [
  "0x794a61358D6845594F94dc1DB02A252b5b4814aD", // Aave v3 Pool
  "0x1eC57cE1DdfdC7a4EbF4F54Aedee19ab73fcBB2E", // CompoundVenue, cUSDCv3
  "0xBBa798A61f0D7D1AE51466Fd4045Cd2Ea25c9A29", // MorphoVenue, bbqUSDC
  "0xb0A125F539237b553025e2cb180f9C40B25918cD", // CompoundVenue, cWETHv3
];

/**
 * No account can predate the factory, so no `VenuePermitted` can either. Scanning from genesis
 * would work and would ask a public RPC for half a billion blocks it is entitled to refuse.
 */
export const FACTORY_BLOCK = 502_979_401n;

export const VENUE_PERMITTED = parseAbiItem(
  "event VenuePermitted(address indexed pool, bool allowed)",
);

const venueAbi = parseAbi([
  "function getReserveAToken(address asset) view returns (address)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
]);

const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
]);

/** One market holding one asset for this account. */
export type VenuePosition = {
  pool: Address;
  asset: Address;
  /** The receipt this market issues for this asset, asked of the market. */
  receipt: Address;
  /**
   * Whether the receipt is a share count rather than an amount.
   *
   * Read from the chain, not configured: our venues answer `getReserveAToken` with **themselves**,
   * which is the trick that lets a Compound market be reached by apps that only know how to ask
   * Aave's questions. Aave's Pool answers with a separate aToken. So a market that names itself is
   * one of ours and prices its shares; one that names another contract is rebasing.
   */
  sharePriced: boolean;
  /** The raw receipt balance. A share count when `sharePriced`. */
  balance: bigint;
  /**
   * The position in the asset's own units.
   *
   * Not the same number as `balance` for a share-priced receipt, and treating them as one is the
   * bug that reached the workflow in #323 — a share count read as an amount of money.
   */
  supplied: bigint;
};

export type VenueReadout = {
  positions: VenuePosition[];
  /** Whether the market list came from the account's logs or from the fallback constants. */
  source: "logs" | "fallback";
};

/**
 * Every market this owner has ever permitted.
 *
 * `venueEverPermitted` is one-way on chain — revoking bars new deposits and never bars the way
 * out — so a single `allowed: true` puts a market in this set for good. That is the set that
 * matters here: a revoked market may still be holding money.
 */
export async function permittedVenues(
  client: PublicClient,
  account: Address,
): Promise<Address[] | null> {
  try {
    const logs = await client.getLogs({
      address: account,
      event: VENUE_PERMITTED,
      fromBlock: FACTORY_BLOCK,
      toBlock: "latest",
    });
    const seen = new Set<string>();
    const out: Address[] = [];
    for (const log of logs) {
      const pool = log.args.pool;
      if (!(log.args.allowed && pool)) continue;
      const key = pool.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(pool);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * What the account holds at every market it has ever permitted.
 *
 * Each read stands alone. A venue answers `getReserveAToken` only for the asset it lists and
 * **reverts** for any other — deliberately, so it cannot be asked about capital it has no way to
 * move — and one such revert must not empty the whole list. The same shape stopped the enclave
 * earlier the same day, where a single reverting call failed an entire batch.
 */
export async function readVenues(
  client: PublicClient,
  account: Address,
  assets: readonly Address[] = ACCOUNT_ASSETS,
): Promise<VenueReadout> {
  const found = await permittedVenues(client, account);
  const pools = found ?? KNOWN_VENUES;
  const source: VenueReadout["source"] = found ? "logs" : "fallback";

  const pairs = pools.flatMap((pool) =>
    assets.map((asset) => ({ pool, asset })),
  );
  const positions = await Promise.all(
    pairs.map(async ({ pool, asset }): Promise<VenuePosition | null> => {
      let receipt: Address;
      try {
        receipt = await client.readContract({
          abi: venueAbi,
          address: pool,
          args: [asset],
          functionName: "getReserveAToken",
        });
      } catch {
        // The market does not list this asset. Not an error, and not a market to sweep.
        return null;
      }
      if (
        !receipt ||
        receipt === "0x0000000000000000000000000000000000000000"
      ) {
        return null;
      }

      const sharePriced = receipt.toLowerCase() === pool.toLowerCase();
      let balance: bigint;
      try {
        balance = await client.readContract({
          abi: erc20Abi,
          address: receipt,
          args: [account],
          functionName: "balanceOf",
        });
      } catch {
        return null;
      }

      let supplied = balance;
      if (sharePriced && balance > 0n) {
        try {
          supplied = await client.readContract({
            abi: venueAbi,
            address: receipt,
            args: [balance],
            functionName: "previewRedeem",
          });
        } catch {
          // Rather than fall back to the share count, which would be a number in the wrong unit
          // presented as money. Zero is wrong too, but wrong in the direction that does not tell
          // an owner they have more than they do.
          supplied = 0n;
        }
      }

      return { pool, asset, receipt, sharePriced, balance, supplied };
    }),
  );

  return { positions: positions.filter((p) => p !== null), source };
}

/**
 * Every token `escape` must be handed, in one list, deduplicated.
 *
 * The assets come first because they are what an owner recognises, and a receipt with a zero
 * balance is still named — `escape` skips a zero without spending anything, and a balance that
 * arrives between building this list and sending it would otherwise be left behind.
 */
export function sweepList(
  positions: readonly VenuePosition[],
  assets: readonly Address[] = ACCOUNT_ASSETS,
): Address[] {
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const token of [...assets, ...positions.map((p) => p.receipt)]) {
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(token);
  }
  return out;
}

/** What the account has at work in one asset, across every market, in that asset's units. */
export function suppliedIn(
  positions: readonly VenuePosition[],
  asset: Address,
): bigint {
  const want = asset.toLowerCase();
  return positions
    .filter((p) => p.asset.toLowerCase() === want)
    .reduce((total, p) => total + p.supplied, 0n);
}

// ── the markets an owner may say yes to ──────────────────────────────────────

/**
 * One market the product offers, and what to call it in front of somebody.
 *
 * Separate from `KNOWN_VENUES` above on purpose. That list is a fallback for sweeping an account
 * that may hold anything; this is a catalogue with names and rates, and the two answer different
 * questions — what might be in there, against what an owner can choose.
 */
export type Market = {
  pool: Address;
  /** The protocol, as somebody who does not read Solidity would say it. */
  label: string;
  asset: Address;
  assetSymbol: string;
  /** The market's own name on that protocol, for anyone who wants to go and look. */
  note: string;
};

/**
 * The four markets deployed and verified on Arbitrum One.
 *
 * **A constant, and it has to be.** Permitting is the one place the owner names an address the
 * account will trust afterwards, so the list of addresses offered cannot come from the chain —
 * anything readable is something someone else can write to. What is derived is everything after
 * the choice: the receipts, the balances, the sweep.
 */
export const MARKETS: readonly Market[] = [
  {
    pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    label: "Aave v3",
    asset: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    assetSymbol: "USDC",
    note: "one pool for every reserve, so it takes ETH too",
  },
  {
    pool: "0x1eC57cE1DdfdC7a4EbF4F54Aedee19ab73fcBB2E",
    label: "Compound v3",
    asset: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    assetSymbol: "USDC",
    note: "cUSDCv3",
  },
  {
    pool: "0xBBa798A61f0D7D1AE51466Fd4045Cd2Ea25c9A29",
    label: "Morpho",
    asset: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    assetSymbol: "USDC",
    note: "Steakhouse High Yield USDC",
  },
  {
    pool: "0xb0A125F539237b553025e2cb180f9C40B25918cD",
    label: "Compound v3",
    asset: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    assetSymbol: "ETH",
    note: "cWETHv3",
  },
];

export type MarketStatus = Market & {
  /**
   * The annual rate in basis points, or null when the market would not answer.
   *
   * Null rather than zero, because a market paying nothing and a market that could not be read
   * are different things and only one of them is a reason not to choose it.
   */
  bps: number | null;
  /** Whether this account currently allows it. False for an account that does not exist yet. */
  permitted: boolean;
};

const reserveDataAbi = parseAbi([
  "function getReserveData(address asset) view returns ((uint256,uint128,uint128,uint128,uint128,uint128,uint40,uint16,address,address,address,address,uint128,uint128,uint128))",
]);

const permittedAbi = parseAbi([
  "function permittedVenue(address pool) view returns (bool)",
]);

/** Aave reports an annual rate in ray. A basis point is 1e23 of one. */
const RAY_PER_BPS = 10n ** 23n;

/**
 * Every market with what it pays and whether this account allows it.
 *
 * Each market is read on its own, for the reason the enclave learned the hard way: a venue lists
 * one asset and **reverts** for any other, and one refusal must not blank the list. An account
 * with no code yet answers nothing, which is not an error — it is what "not opened" looks like.
 */
export async function readMarkets(
  client: PublicClient,
  account: Address | null,
): Promise<MarketStatus[]> {
  return Promise.all(
    MARKETS.map(async (market): Promise<MarketStatus> => {
      const [bps, permitted] = await Promise.all([
        client
          .readContract({
            abi: reserveDataAbi,
            address: market.pool,
            args: [market.asset],
            functionName: "getReserveData",
          })
          .then((data) => Number(data[2] / RAY_PER_BPS))
          .catch(() => null),
        account
          ? client
              .readContract({
                abi: permittedAbi,
                address: account,
                args: [market.pool],
                functionName: "permittedVenue",
              })
              .catch(() => false)
          : Promise.resolve(false),
      ]);
      return { ...market, bps, permitted };
    }),
  );
}

/** The best rate on offer, for saying what an owner is leaving behind. */
export function bestBps(markets: readonly MarketStatus[]): number | null {
  const rates = markets.map((m) => m.bps).filter((b) => b !== null);
  return rates.length ? Math.max(...rates) : null;
}
