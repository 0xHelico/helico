import { Address } from '@1inch/sdk-core'
import { AquaXYCAmmStrategy, MakerTraits, Order } from '@1inch/swap-vm-sdk'

import { concentratedRange, type Token } from './price'

export type ConcentratedPosition = {
	/** The pair. Order is irrelevant — Aqua sorts it, and `price` says which way round to read. */
	base: Token
	quote: Token
	/** Band edges as quote-per-base, scaled 1e18. ETH from $2,800 to $3,200 is `2800n * ONE`. */
	priceMin: bigint
	priceMax: bigint
	/** Swap fee in basis points, kept by the maker. */
	feeBps: number
	/** Aqua refuses to re-ship a hash it has seen, so re-issuing the same band needs a new salt. */
	salt?: bigint
	maker: `0x${string}`
}

/**
 * One concentrated position, as the bytes Aqua files it under.
 *
 * The pricing is 1inch's `concentrate` instruction running inside their deployed SwapVM, not
 * arithmetic of ours. That is the point: constant product is the baseline their example is named
 * after, and writing our own curve six days out is how fixed-point edge cases get discovered on
 * the twelfth.
 *
 * `strategy` is what goes to `Aqua.ship`, and it is the **encoded order**, not the bare program.
 * Aqua hashes whatever bytes it is given (`strategyHash = keccak256(strategy)`), while SwapVM
 * looks the balance up under the order's own hash. Ship the program alone and the two disagree,
 * every quote reverts with `SafeBalancesForTokenNotInActiveStrategy` naming a hash Aqua is
 * holding, and nothing tells you the two hashes were computed over different bytes.
 */
export function concentratedStrategy(p: ConcentratedPosition): {
	order: Order
	strategy: `0x${string}`
} {
	const { rawPriceMin, rawPriceMax } = concentratedRange(p.priceMin, p.priceMax, p.base, p.quote)
	let builder = AquaXYCAmmStrategy.newConcentrate({ rawPriceMin, rawPriceMax }).withFeeTokenIn(
		p.feeBps,
	)
	if (p.salt !== undefined) builder = builder.withSalt(p.salt)
	const order = Order.new({
		maker: new Address(p.maker),
		program: builder.build(),
		traits: MakerTraits.default(),
	})
	return { order, strategy: String(order.encode()) as `0x${string}` }
}
