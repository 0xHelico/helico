import type { Range } from './decision'
import {
	type Amounts,
	estimateSwap,
	getAmount0Delta,
	getAmount1Delta,
	getAmountsForLiquidity,
	getSqrtRatioAtTick,
	Q96,
} from './math'

export type SizingInput = {
	/** Liquidity of the position being moved, as `getPositionLiquidity` reports it. */
	liquidity: bigint
	sqrtPriceX96: bigint
	current: Range
	proposed: Range
	/** The pool's active liquidity, what a swap trades against inside the current tick. */
	poolLiquidity: bigint
	/** The pool's LP fee in pips (hundredths of a bip, 1e6 = 100%). */
	feePips: number
	/** Tolerance applied to the burn's floors, the swap's floor, and the liquidity minted. */
	slippageBps: number
}

export type Sizing = {
	liquidityToMint: bigint
	amount0Min: bigint
	amount1Min: bigint
	amount0Max: bigint
	amount1Max: bigint
	zeroForOne: boolean
	amountIn: bigint
	minAmountOut: bigint
	/** What the burn is expected to return at the price it was sized at. */
	withdrawn: Amounts
	/** Where the swap is expected to leave the price. */
	sqrtPriceAfter: bigint
}

const BPS = 10_000n
const PIPS = 1_000_000n
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b)

const liquidityFor0 = (sqrtP: bigint, sqrtA: bigint, sqrtB: bigint, amount0: bigint): bigint => {
	if (sqrtP >= sqrtB) return 0n
	const lo = sqrtP > sqrtA ? sqrtP : sqrtA
	return (amount0 * lo * sqrtB) / (Q96 * (sqrtB - lo))
}
const liquidityFor1 = (sqrtP: bigint, sqrtA: bigint, sqrtB: bigint, amount1: bigint): bigint => {
	if (sqrtP <= sqrtA) return 0n
	const hi = sqrtP < sqrtB ? sqrtP : sqrtB
	return (amount1 * Q96) / (hi - sqrtA)
}

type Candidate = {
	amountIn: bigint
	amountOut: bigint
	sqrtPriceAfter: bigint
	l0: bigint
	l1: bigint
}

/**
 * Sizes the swap that turns what the burn returns into what the new range wants, and the mint
 * the result funds. A one-sided withdrawal (every out-of-range position) buys no two-sided range
 * without it. The swap is estimated at the pool's active liquidity and bounded so the price
 * stays inside the new range, which is also where the vault's `sqrtPriceLimitX96` stops it; if
 * it stops early the retention floor rejects the batch and the enclave retries after the
 * cooldown. Everything the vault must not exceed is scaled by the slippage. This is the strategy
 * the enclave keeps to itself.
 */
export function sizeRecentre(input: SizingInput): Sizing {
	const {
		liquidity,
		sqrtPriceX96: sqrtP,
		current,
		proposed,
		poolLiquidity,
		feePips,
		slippageBps,
	} = input
	const scale = (x: bigint): bigint => (x * (BPS - BigInt(slippageBps))) / BPS
	const withdrawn = getAmountsForLiquidity(
		sqrtP,
		getSqrtRatioAtTick(current.tickLower),
		getSqrtRatioAtTick(current.tickUpper),
		liquidity,
	)
	const sqrtA = getSqrtRatioAtTick(proposed.tickLower)
	const sqrtB = getSqrtRatioAtTick(proposed.tickUpper)

	// Which token is in excess for the new range at today's price decides the direction.
	const zeroForOne =
		liquidityFor0(sqrtP, sqrtA, sqrtB, withdrawn.amount0) >
		liquidityFor1(sqrtP, sqrtA, sqrtB, withdrawn.amount1)

	const evaluate = (amountIn: bigint): Candidate => {
		const { sqrtPriceAfter, amountOut } =
			amountIn === 0n || poolLiquidity === 0n
				? { sqrtPriceAfter: sqrtP, amountOut: 0n }
				: estimateSwap(sqrtP, poolLiquidity, amountIn, zeroForOne, feePips)
		const held0 = zeroForOne ? withdrawn.amount0 - amountIn : withdrawn.amount0 + amountOut
		const held1 = zeroForOne ? withdrawn.amount1 + amountOut : withdrawn.amount1 - amountIn
		return {
			amountIn,
			amountOut,
			sqrtPriceAfter,
			l0: liquidityFor0(sqrtPriceAfter, sqrtA, sqrtB, held0),
			l1: liquidityFor1(sqrtPriceAfter, sqrtA, sqrtB, held1),
		}
	}

	// The most input the pool takes before the price reaches the new range's edge in the swap's
	// direction, grossed back up for the fee, and never more than what the burn returns.
	const available = zeroForOne ? withdrawn.amount0 : withdrawn.amount1
	let hi = 0n
	if (poolLiquidity > 0n) {
		const toEdge = zeroForOne
			? getAmount0Delta(sqrtA, sqrtP, poolLiquidity, false)
			: getAmount1Delta(sqrtP, sqrtB, poolLiquidity, false)
		// The bound is the edge itself, not one unit inside it.
		//
		// The vault treats the upper edge as exclusive and reverts `PriceLeftTheRange` on a tick
		// at or above it, so shaving a unit off here looks like the safe thing to do. It is not
		// needed, and the reason is worth knowing: the vault's own swap already passes
		// `sqrtPriceLimitX96 = getSqrtPriceAtTick(tickUpper) - 1`, so the pool halts at
		// `tickUpper - 1` however much this asks for. `ForkSwapRecentreTest` asserts exactly
		// that against the live pool, with an input deliberately sized to cross the edge.
		//
		// A version of this with `toEdge - 1n` was written and left on a branch. Neither its
		// test nor any case that could be constructed here tells the two apart — the binary
		// search below never selects `hi`, so the unit is invisible. Unobservable arithmetic
		// with a comment claiming it prevents something is worse than the plain bound.
		hi = min(available, (toEdge * PIPS) / (PIPS - BigInt(feePips)))
	}

	// The side we sell from shrinks and the side we buy grows with the input, so the largest
	// fundable liquidity is where they cross: binary search on the sign of that difference.
	let lo = 0n
	let best = evaluate(0n)
	const excess = (c: Candidate): boolean => (zeroForOne ? c.l0 >= c.l1 : c.l1 >= c.l0)
	while (hi - lo > 1n) {
		const mid = (lo + hi) / 2n
		const c = evaluate(mid)
		if (excess(c)) lo = mid
		else hi = mid
		if (min(c.l0, c.l1) > min(best.l0, best.l1)) best = c
	}
	for (const x of [lo, hi]) {
		const c = evaluate(x)
		if (min(c.l0, c.l1) > min(best.l0, best.l1)) best = c
	}

	const held0 = zeroForOne ? withdrawn.amount0 - best.amountIn : withdrawn.amount0 + best.amountOut
	const held1 = zeroForOne ? withdrawn.amount1 + best.amountOut : withdrawn.amount1 - best.amountIn
	return {
		liquidityToMint: scale(min(best.l0, best.l1)),
		amount0Min: scale(withdrawn.amount0),
		amount1Min: scale(withdrawn.amount1),
		amount0Max: held0,
		amount1Max: held1,
		zeroForOne,
		amountIn: best.amountIn,
		minAmountOut: scale(best.amountOut),
		withdrawn,
		sqrtPriceAfter: best.sqrtPriceAfter,
	}
}
