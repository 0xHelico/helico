import { describe, expect, test } from 'bun:test'
import { SqrtPriceMath, maxLiquidityForAmounts as sdkMaxLiquidity, TickMath } from '@uniswap/v3-sdk'
import JSBI from 'jsbi'
import {
	estimateSwap,
	getAmount0Delta,
	getAmount1Delta,
	getAmountsForLiquidity,
	getNextSqrtPriceFromInput,
	getSqrtRatioAtTick,
	maxLiquidityForAmounts,
} from './math'

const big = (x: bigint) => JSBI.BigInt(x.toString())
const ticks = [
	-887_272, -400_000, -65, -64, -1, 0, 1, 63, 65, 1_000, 12_345, 100_000, 443_636, 887_272,
]

describe('getSqrtRatioAtTick', () => {
	test.each(ticks)('matches the Uniswap SDK at tick %d', (tick) => {
		expect(getSqrtRatioAtTick(tick).toString()).toBe(TickMath.getSqrtRatioAtTick(tick).toString())
	})

	test('sits just below the live Robinhood testnet pool price at tick -65', () => {
		const live = 78_971_408_793_868_239_585_893_302_751n
		expect(getSqrtRatioAtTick(-65)).toBeLessThanOrEqual(live)
		expect(getSqrtRatioAtTick(-64)).toBeGreaterThan(live)
	})

	test('rejects ticks outside the protocol range', () => {
		expect(() => getSqrtRatioAtTick(887_273)).toThrow(RangeError)
	})
})

describe('amount deltas', () => {
	const cases: [number, number, bigint][] = [
		[0, 100, 1_000_000_000_000n],
		[-560, 440, 123_456_789_012_345n],
		[-887_272, 887_272, 1n],
		[100, 0, 7n],
	]
	test.each(cases)(
		'token0 and token1 for [%d, %d] and L=%s match the SDK, both roundings',
		(a, b, l) => {
			const sa = getSqrtRatioAtTick(a)
			const sb = getSqrtRatioAtTick(b)
			for (const roundUp of [false, true]) {
				expect(getAmount0Delta(sa, sb, l, roundUp).toString()).toBe(
					SqrtPriceMath.getAmount0Delta(big(sa), big(sb), big(l), roundUp).toString(),
				)
				expect(getAmount1Delta(sa, sb, l, roundUp).toString()).toBe(
					SqrtPriceMath.getAmount1Delta(big(sa), big(sb), big(l), roundUp).toString(),
				)
			}
		},
	)
})

describe('maxLiquidityForAmounts', () => {
	const grid = [
		{ p: -65, a: -560, b: 440 },
		{ p: -1_000, a: -560, b: 440 },
		{ p: 1_000, a: -560, b: 440 },
		{ p: 0, a: -10, b: 10 },
		{ p: 12_345, a: 12_340, b: 12_400 },
	]
	test.each(grid)('matches the SDK (full precision) for %o', ({ p, a, b }) => {
		for (const [amount0, amount1] of [
			[10n ** 18n, 10n ** 18n],
			[10n ** 15n, 3n * 10n ** 18n],
			[0n, 10n ** 18n],
			[10n ** 18n, 0n],
		]) {
			const sp = getSqrtRatioAtTick(p)
			const sa = getSqrtRatioAtTick(a)
			const sb = getSqrtRatioAtTick(b)
			expect(maxLiquidityForAmounts(sp, sa, sb, amount0, amount1).toString()).toBe(
				sdkMaxLiquidity(big(sp), big(sa), big(sb), big(amount0), big(amount1), true).toString(),
			)
		}
	})
})

describe('getAmountsForLiquidity', () => {
	const sa = getSqrtRatioAtTick(-560)
	const sb = getSqrtRatioAtTick(440)
	const l = 10n ** 15n

	test('below the range it is all token0, above it all token1, inside it both', () => {
		expect(getAmountsForLiquidity(getSqrtRatioAtTick(-1_000), sa, sb, l).amount1).toBe(0n)
		expect(getAmountsForLiquidity(getSqrtRatioAtTick(1_000), sa, sb, l).amount0).toBe(0n)
		const inside = getAmountsForLiquidity(getSqrtRatioAtTick(-65), sa, sb, l)
		expect(inside.amount0).toBeGreaterThan(0n)
		expect(inside.amount1).toBeGreaterThan(0n)
	})

	test('round-trips: the amounts a burn returns buy back no more than the burned liquidity', () => {
		for (const p of [-1_000, -65, 0, 439, 1_000]) {
			const sp = getSqrtRatioAtTick(p)
			const { amount0, amount1 } = getAmountsForLiquidity(sp, sa, sb, l)
			const back = maxLiquidityForAmounts(sp, sa, sb, amount0, amount1)
			expect(back).toBeLessThanOrEqual(l)
			// Rounding costs a few parts per trillion, never more.
			expect(back).toBeGreaterThan(l - l / 1_000_000_000n)
		}
	})

	test("matches the SDK's deltas branch by branch, rounding down", () => {
		for (const p of [-1_000, -560, -65, 439, 440, 1_000]) {
			const sp = getSqrtRatioAtTick(p)
			const expected = {
				amount0:
					sp >= sb
						? 0n
						: BigInt(
								SqrtPriceMath.getAmount0Delta(
									big(sp > sa ? sp : sa),
									big(sb),
									big(l),
									false,
								).toString(),
							),
				amount1:
					sp <= sa
						? 0n
						: BigInt(
								SqrtPriceMath.getAmount1Delta(
									big(sa),
									big(sp < sb ? sp : sb),
									big(l),
									false,
								).toString(),
							),
			}
			expect(getAmountsForLiquidity(sp, sa, sb, l)).toEqual(expected)
		}
	})
})

describe('getNextSqrtPriceFromInput', () => {
	const sp = getSqrtRatioAtTick(-65)
	test.each([
		[10n ** 18n, 10n ** 12n, true],
		[10n ** 18n, 10n ** 12n, false],
		[10n ** 15n, 48_524_977_311_541n, true],
		[10n ** 15n, 45_527_510_024_630n, false],
		[1n, 1n, true],
	])(
		'matches the SDK for liquidity %s, input %s, zeroForOne %s',
		(liquidity, amountIn, zeroForOne) => {
			expect(getNextSqrtPriceFromInput(sp, liquidity, amountIn, zeroForOne).toString()).toBe(
				SqrtPriceMath.getNextSqrtPriceFromInput(
					big(sp),
					big(liquidity),
					big(amountIn),
					zeroForOne,
				).toString(),
			)
		},
	)

	test('estimateSwap takes the fee off the input and pays out the price delta', () => {
		const { sqrtPriceAfter, amountOut } = estimateSwap(sp, 10n ** 18n, 10n ** 12n, true, 500)
		const inLessFee = (10n ** 12n * 999_500n) / 1_000_000n
		expect(sqrtPriceAfter).toBe(getNextSqrtPriceFromInput(sp, 10n ** 18n, inLessFee, true))
		expect(amountOut).toBe(getAmount1Delta(sqrtPriceAfter, sp, 10n ** 18n, false))
		expect(estimateSwap(sp, 10n ** 18n, 10n ** 12n, true, 0).amountOut).toBeGreaterThan(amountOut)
	})
})
