/**
 * Turning "ETH between $2,800 and $3,200" into the two numbers `concentrate` wants.
 *
 * This is the whole reason the file exists. The conversion is easy to get wrong and **wrong does
 * not revert** — a first attempt here passed `2800 * 1e18` and got a quote back at
 * `$2,808,428,656,082,635` with an output of zero. It priced. The number was nonsense.
 *
 * Two rules, and the second is the one that bites:
 *
 * 1. The price is `tokenGt / tokenLt` — the higher-addressed token per the lower-addressed one.
 *    Which token is which is decided by comparing the addresses as numbers, so **it flips
 *    between chains for the same pair.** On Arbitrum One WETH (`0x82aF…`) sorts below USDC
 *    (`0xaf88…`), so the price is USDC per WETH — the familiar direction. On Ethereum USDC
 *    (`0xa0b8…`) sorts below WETH (`0xc02a…`) and it inverts. Nothing about the pair changed.
 *
 * 2. It is a ratio of **raw** amounts, not human ones, in 1e18 fixed point. USDC has 6 decimals
 *    and WETH has 18, so ETH at $3,000 is `3000e6 / 1e18 = 3e-9`, which is `3e9` in 1e18 fixed
 *    point — not `3000e18`. That factor of 1e12 is the whole bug.
 *
 * Verified against the deployed SwapVM on a fork of Arbitrum One, not read off a document: with
 * these numbers a 2800–3200 range on 10 WETH + 20,000 USDC quotes 1,000 USDC at $2,967.26, and
 * tightening the range to 2900–3100 improves it to $2,989.53. Both are inside the band and move
 * the right way, which a 1e12 error could not fake.
 */

/** 1e18, the fixed-point scale `concentrate` reads its prices in. */
export const ONE = 10n ** 18n

export type Token = { address: `0x${string}`; decimals: number }

/** Aqua orders a pair by address, numerically. Everything else here follows from that. */
export function sortPair(a: Token, b: Token): { lt: Token; gt: Token } {
	return BigInt(a.address) < BigInt(b.address) ? { lt: a, gt: b } : { lt: b, gt: a }
}

/**
 * `price` is how much `quote` one whole `base` is worth, scaled by 1e18 — so ETH at $3,000
 * against USDC is `3000n * ONE`, whatever the tokens' own decimals are.
 *
 * Returns the ratio `concentrate` wants. Order the two calls yourself: inverting a range also
 * reverses it, which `concentratedRange` below handles.
 */
export function rawPrice(price: bigint, base: Token, quote: Token): bigint {
	if (price <= 0n) throw new Error('price must be positive')
	const { lt, gt } = sortPair(base, quote)
	const scale = (t: Token) => 10n ** BigInt(t.decimals)
	// base is the lower-addressed token: the quoted direction is already gt/lt.
	if (lt.address === base.address) return (price * scale(gt)) / scale(lt)
	// base is the higher-addressed one, so gt/lt is the reciprocal of the price asked for.
	return (ONE * ONE * scale(gt)) / (price * scale(lt))
}

/**
 * A price band as `concentrate` takes it: `rawPriceMin` below `rawPriceMax`.
 *
 * When the pair inverts, so does the band — the *lowest* price of the base becomes the
 * *highest* ratio. Getting this backwards is silent too: the SDK accepts min > max and the
 * position simply never quotes what you meant.
 */
export function concentratedRange(
	priceMin: bigint,
	priceMax: bigint,
	base: Token,
	quote: Token,
): { rawPriceMin: bigint; rawPriceMax: bigint } {
	if (priceMin >= priceMax) throw new Error('priceMin must be below priceMax')
	const a = rawPrice(priceMin, base, quote)
	const b = rawPrice(priceMax, base, quote)
	return a < b ? { rawPriceMin: a, rawPriceMax: b } : { rawPriceMin: b, rawPriceMax: a }
}
