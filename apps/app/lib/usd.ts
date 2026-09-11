"use client";

import { type Address, type PublicClient, parseAbi, parseUnits } from "viem";

/**
 * A dollar amount, turned into token units by a feed rather than by a model.
 *
 * The backend reads "$5 of ETH" and reports the dollars; it does not divide. That is deliberate and
 * it is the reason this file exists: a model asked to convert produces a number with no source, and
 * an amount somebody signs must have one. So the figure in the card comes from Chainlink, read by
 * the same wallet that is about to sign.
 *
 * **Every address below was verified by asking the feed what it is**, not copied from a page:
 *
 * ```
 * 0x639Fe6ab…  "ETH / USD"
 * 0x50834F31…  "USDC / USD"
 * 0x3f3f5dF8…  "USDT / USD"
 * 0xb2A82404…  "ARB / USD"
 * ```
 *
 * A token with no feed here is refused by name. Treating a stablecoin as exactly a dollar would be
 * the same guess in a friendlier costume, and it is wrong on the day it matters.
 */
const FEEDS: Record<string, Address> = {
  // Native ether and its wrapper share a price, and the app may ask with either.
  "0x0000000000000000000000000000000000000000":
    "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",
  "0x82af49447d8a07e3bd95bd0d56f35241523fbab1":
    "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",
  "0xaf88d065e77c8cc2239327c5edb3a432268e5831":
    "0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3",
  "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9":
    "0x3f3f5dF88dC9F13eac63DF89EC16ef6e7E25DdE7",
  "0x912ce59144191c1204e64559fe8253a0e49e6548":
    "0xb2A824043730FE05F3DA2efaFa1CBbe83fa548D6",
};

const feedAbi = parseAbi([
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function decimals() view returns (uint8)",
]);

/** A feed older than this is not a price. An hour is generous for these pairs and still finite. */
const STALE_AFTER_SECONDS = 3600n;

/**
 * How many base units of `token` are worth `dollars`.
 *
 * Throws rather than guessing: no feed, a non-positive answer, or an answer too old to be a price.
 * A swap card that refuses is cheap; one that sizes a signature off a stale number is not.
 */
export async function unitsForDollars(
  client: PublicClient,
  token: Address,
  decimals: number,
  dollars: string,
): Promise<bigint> {
  const feed = FEEDS[token.toLowerCase()];
  if (!feed) {
    throw new Error(
      "I have no price feed for that token, so I cannot turn dollars into an amount of it. Say the amount in tokens instead.",
    );
  }
  const [round, feedDecimals] = await Promise.all([
    client.readContract({
      abi: feedAbi,
      address: feed,
      functionName: "latestRoundData",
    }),
    client.readContract({
      abi: feedAbi,
      address: feed,
      functionName: "decimals",
    }),
  ]);
  const answer = round[1];
  const updatedAt = round[3];
  if (answer <= 0n) throw new Error("The price feed answered with nothing.");
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (updatedAt === 0n || now - updatedAt > STALE_AFTER_SECONDS) {
    throw new Error(
      "The price feed has not updated in over an hour, so I will not size a swap from it.",
    );
  }

  // Dollars are parsed at the feed's own scale, so both sides carry the same factor and it
  // cancels: `cents / answer` is a plain ratio, and multiplying by the token's decimals turns it
  // into base units. Integer throughout, so the rounding is one unit at the end rather than a
  // float somewhere in the middle.
  const cents = parseUnits(dollars, Number(feedDecimals));
  const units = (cents * 10n ** BigInt(decimals)) / BigInt(answer);
  if (units === 0n) {
    throw new Error("That is too small to be an amount of that token.");
  }
  return units;
}
