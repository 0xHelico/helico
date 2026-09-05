import type { Range } from './decision'
import {
	type Amounts,
	getAmountsForLiquidity,
	getSqrtRatioAtTick,
	maxLiquidityForAmounts,
} from './math'

export type SizingInput = {
	/** Liquidity of the position being moved, as `getPositionLiquidity` reports it. */
	liquidity: bigint
	sqrtPriceX96: bigint
	current: Range
	proposed: Range
	/** Tolerance applied to what the burn returns and to the liquidity minted from it. */
	slippageBps: number
}

export type Sizing = {
	liquidityToMint: bigint
	amount0Min: bigint
	amount1Min: bigint
	amount0Max: bigint
	amount1Max: bigint
	/** What the burn is expected to return at the price it was sized at. */
	withdrawn: Amounts
}

const BPS = 10_000n

/**
 * Sizes the mint the vault will fund from the burn. The withdrawal's floors and the new
 * liquidity are both scaled down by the slippage, so a price move between this read and the
 * transaction has room; the ceilings are the withdrawn amounts, since the mint has no other
 * source of funds. This is the strategy the enclave keeps to itself.
 */
export function sizeRecentre({
	liquidity,
	sqrtPriceX96,
	current,
	proposed,
	slippageBps,
}: SizingInput): Sizing {
	const scale = (x: bigint): bigint => (x * (BPS - BigInt(slippageBps))) / BPS
	const withdrawn = getAmountsForLiquidity(
		sqrtPriceX96,
		getSqrtRatioAtTick(current.tickLower),
		getSqrtRatioAtTick(current.tickUpper),
		liquidity,
	)
	const liquidityToMint = scale(
		maxLiquidityForAmounts(
			sqrtPriceX96,
			getSqrtRatioAtTick(proposed.tickLower),
			getSqrtRatioAtTick(proposed.tickUpper),
			withdrawn.amount0,
			withdrawn.amount1,
		),
	)
	return {
		liquidityToMint,
		amount0Min: scale(withdrawn.amount0),
		amount1Min: scale(withdrawn.amount1),
		amount0Max: withdrawn.amount0,
		amount1Max: withdrawn.amount1,
		withdrawn,
	}
}
