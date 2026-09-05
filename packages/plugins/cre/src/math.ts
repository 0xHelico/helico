/**
 * The slice of Uniswap's v3/v4 core arithmetic the enclave needs, on native `BigInt` so the
 * WASM bundle carries no JSBI. Every function is cross-checked against `@uniswap/v3-sdk` in
 * `math.test.ts`; keep that test when touching anything here.
 */

export const Q96 = 1n << 96n
export const MIN_TICK = -887272
export const MAX_TICK = 887272
const MAX_UINT256 = (1n << 256n) - 1n

// TickMath.getSqrtRatioAtTick: one factor per bit of |tick|, each 2^-128-scaled.
const TICK_FACTORS: readonly [number, bigint][] = [
	[0x2, 0xfff97272373d413259a46990580e213an],
	[0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn],
	[0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
	[0x10, 0xffcb9843d60f6159c9db58835c926644n],
	[0x20, 0xff973b41fa98c081472e6896dfb254c0n],
	[0x40, 0xff2ea16466c96a3843ec78b326b52861n],
	[0x80, 0xfe5dee046a99a2a811c461f1969c3053n],
	[0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
	[0x200, 0xf987a7253ac413176f2b074cf7815e54n],
	[0x400, 0xf3392b0822b70005940c7a398e4b70f3n],
	[0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n],
	[0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
	[0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n],
	[0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n],
	[0x8000, 0x31be135f97d08fd981231505542fcfa6n],
	[0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
	[0x20000, 0x5d6af8dedb81196699c329225ee604n],
	[0x40000, 0x2216e584f5fa1ea926041bedfe98n],
	[0x80000, 0x48a170391f7dc42444e8fa2n],
]

/** sqrt(1.0001^tick) as a Q64.96, exactly as the pool computes it. */
export function getSqrtRatioAtTick(tick: number): bigint {
	const absTick = tick < 0 ? -tick : tick
	if (absTick > MAX_TICK) throw new RangeError(`tick ${tick} is outside the protocol's range`)
	let ratio =
		(absTick & 1) !== 0 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n
	for (const [bit, factor] of TICK_FACTORS) {
		if ((absTick & bit) !== 0) ratio = (ratio * factor) >> 128n
	}
	if (tick > 0) ratio = MAX_UINT256 / ratio
	// Round up from Q128 to Q96 so that getTickAtSqrtRatio of the result gives back the tick.
	return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n)
}

const divRoundingUp = (a: bigint, b: bigint): bigint => a / b + (a % b === 0n ? 0n : 1n)
const mulDivRoundingUp = (a: bigint, b: bigint, d: bigint): bigint => divRoundingUp(a * b, d)
const ordered = (a: bigint, b: bigint): [bigint, bigint] => (a > b ? [b, a] : [a, b])

/** Token0 owed for `liquidity` between two sqrt prices (SqrtPriceMath.getAmount0Delta). */
export function getAmount0Delta(
	sqrtA: bigint,
	sqrtB: bigint,
	liquidity: bigint,
	roundUp: boolean,
): bigint {
	const [lo, hi] = ordered(sqrtA, sqrtB)
	const numerator1 = liquidity << 96n
	const numerator2 = hi - lo
	return roundUp
		? divRoundingUp(mulDivRoundingUp(numerator1, numerator2, hi), lo)
		: (numerator1 * numerator2) / hi / lo
}

/** Token1 owed for `liquidity` between two sqrt prices (SqrtPriceMath.getAmount1Delta). */
export function getAmount1Delta(
	sqrtA: bigint,
	sqrtB: bigint,
	liquidity: bigint,
	roundUp: boolean,
): bigint {
	const [lo, hi] = ordered(sqrtA, sqrtB)
	return roundUp ? mulDivRoundingUp(liquidity, hi - lo, Q96) : (liquidity * (hi - lo)) / Q96
}

export type Amounts = { amount0: bigint; amount1: bigint }

/** What burning `liquidity` over [sqrtA, sqrtB] returns at price sqrtP, rounded down as the pool does. */
export function getAmountsForLiquidity(
	sqrtP: bigint,
	sqrtA: bigint,
	sqrtB: bigint,
	liquidity: bigint,
): Amounts {
	const [lo, hi] = ordered(sqrtA, sqrtB)
	if (sqrtP <= lo) return { amount0: getAmount0Delta(lo, hi, liquidity, false), amount1: 0n }
	if (sqrtP < hi) {
		return {
			amount0: getAmount0Delta(sqrtP, hi, liquidity, false),
			amount1: getAmount1Delta(lo, sqrtP, liquidity, false),
		}
	}
	return { amount0: 0n, amount1: getAmount1Delta(lo, hi, liquidity, false) }
}

const maxLiquidityForAmount0 = (sqrtA: bigint, sqrtB: bigint, amount0: bigint): bigint => {
	const [lo, hi] = ordered(sqrtA, sqrtB)
	return (amount0 * lo * hi) / (Q96 * (hi - lo))
}
const maxLiquidityForAmount1 = (sqrtA: bigint, sqrtB: bigint, amount1: bigint): bigint => {
	const [lo, hi] = ordered(sqrtA, sqrtB)
	return (amount1 * Q96) / (hi - lo)
}

/** The most liquidity `amount0` and `amount1` buy over [sqrtA, sqrtB] at sqrtP (full precision). */
export function maxLiquidityForAmounts(
	sqrtP: bigint,
	sqrtA: bigint,
	sqrtB: bigint,
	amount0: bigint,
	amount1: bigint,
): bigint {
	const [lo, hi] = ordered(sqrtA, sqrtB)
	if (sqrtP <= lo) return maxLiquidityForAmount0(lo, hi, amount0)
	if (sqrtP < hi) {
		const l0 = maxLiquidityForAmount0(sqrtP, hi, amount0)
		const l1 = maxLiquidityForAmount1(lo, sqrtP, amount1)
		return l0 < l1 ? l0 : l1
	}
	return maxLiquidityForAmount1(lo, hi, amount1)
}

/** The pool's next sqrt price after `amountIn` (fee already removed) at constant liquidity (SqrtPriceMath.getNextSqrtPriceFromInput). */
export function getNextSqrtPriceFromInput(
	sqrtP: bigint,
	liquidity: bigint,
	amountIn: bigint,
	zeroForOne: boolean,
): bigint {
	if (sqrtP <= 0n || liquidity <= 0n) throw new RangeError('price and liquidity must be positive')
	if (zeroForOne) {
		if (amountIn === 0n) return sqrtP
		const numerator1 = liquidity << 96n
		return divRoundingUp(numerator1 * sqrtP, numerator1 + amountIn * sqrtP)
	}
	return sqrtP + (amountIn << 96n) / liquidity
}

export type SwapEstimate = { sqrtPriceAfter: bigint; amountOut: bigint }

/**
 * One constant-liquidity swap step as the pool computes it: the LP fee comes off the input, the
 * price moves, the output is the delta between the two prices. Tick crossings are ignored, so
 * this is exact inside the active tick and optimistic beyond it; the caller keeps a margin.
 */
export function estimateSwap(
	sqrtP: bigint,
	liquidity: bigint,
	amountIn: bigint,
	zeroForOne: boolean,
	feePips: number,
): SwapEstimate {
	const amountInLessFee = (amountIn * (1_000_000n - BigInt(feePips))) / 1_000_000n
	const sqrtPriceAfter = getNextSqrtPriceFromInput(sqrtP, liquidity, amountInLessFee, zeroForOne)
	const amountOut = zeroForOne
		? getAmount1Delta(sqrtPriceAfter, sqrtP, liquidity, false)
		: getAmount0Delta(sqrtP, sqrtPriceAfter, liquidity, false)
	return { sqrtPriceAfter, amountOut }
}
