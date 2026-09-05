import { describe, expect, test } from 'bun:test'
import { getAmount0Delta, getAmount1Delta, getSqrtRatioAtTick } from './math'
import type { Sizing } from './sizing'
import { sizeRecentre } from './sizing'

describe('sizeRecentre', () => {
	const sqrtPriceX96 = 78_971_408_793_868_239_585_893_302_751n // the live testnet pool, tick -65
	const liquidity = 10n ** 15n
	const pool = { poolLiquidity: 0n, feePips: 500 }
	const deep = { poolLiquidity: 10n ** 18n, feePips: 500 }
	const proposed = { tickLower: -560, tickUpper: 440 }

	/** What the mint needs at the post-swap price, rounded up as the position manager does, fits what is held. */
	const affordable = (s: Sizing) => {
		const need0 = getAmount0Delta(
			s.sqrtPriceAfter,
			getSqrtRatioAtTick(proposed.tickUpper),
			s.liquidityToMint,
			true,
		)
		const need1 = getAmount1Delta(
			getSqrtRatioAtTick(proposed.tickLower),
			s.sqrtPriceAfter,
			s.liquidityToMint,
			true,
		)
		expect(need0).toBeLessThanOrEqual(s.amount0Max)
		expect(need1).toBeLessThanOrEqual(s.amount1Max)
	}

	test('an out-of-range position holds one token, and one token buys no two-sided range', () => {
		// Below its range the old position is all token0. A range containing the price needs both
		// tokens, and the vault's burn-and-mint plan has no swap, so nothing can be minted.
		const s = sizeRecentre({
			liquidity,
			sqrtPriceX96,
			current: { tickLower: 100, tickUpper: 1_100 },
			proposed,
			...pool,
			slippageBps: 50,
		})
		expect(s.withdrawn.amount1).toBe(0n)
		expect(s.withdrawn.amount0).toBeGreaterThan(0n)
		expect(s.liquidityToMint).toBe(0n)
	})

	test('the mint it proposes is affordable from the burn, with the slippage margin', () => {
		// In range but off-centre: the burn returns both tokens and a centred range can be funded.
		const s = sizeRecentre({
			liquidity,
			sqrtPriceX96,
			current: { tickLower: -1_000, tickUpper: 0 },
			proposed,
			...pool,
			slippageBps: 50,
		})
		expect(s.withdrawn.amount0).toBeGreaterThan(0n)
		expect(s.withdrawn.amount1).toBeGreaterThan(0n)
		expect(s.liquidityToMint).toBeGreaterThan(0n)
		expect(s.liquidityToMint).toBeLessThan(liquidity)
		// What the mint needs, rounded up as the position manager does, fits under the ceilings.
		const need0 = getAmount0Delta(sqrtPriceX96, getSqrtRatioAtTick(440), s.liquidityToMint, true)
		const need1 = getAmount1Delta(getSqrtRatioAtTick(-560), sqrtPriceX96, s.liquidityToMint, true)
		expect(need0).toBeLessThanOrEqual(s.amount0Max)
		expect(need1).toBeLessThanOrEqual(s.amount1Max)
		// Floors are the withdrawn amounts less the slippage.
		expect(s.amount0Min).toBe((s.withdrawn.amount0 * 9_950n) / 10_000n)
		expect(s.amount1Min).toBe((s.withdrawn.amount1 * 9_950n) / 10_000n)
	})

	test('an in-range position re-centred on itself keeps almost all of its liquidity', () => {
		const s = sizeRecentre({
			liquidity,
			sqrtPriceX96,
			current: { tickLower: -560, tickUpper: 440 },
			proposed,
			...pool,
			slippageBps: 0,
		})
		expect(s.liquidityToMint).toBeLessThanOrEqual(liquidity)
		expect(s.liquidityToMint).toBeGreaterThan(liquidity - 1_000n)
	})

	test('one-sided withdrawals need a one-sided target: all-token1 cannot fund a range above the price', () => {
		const s = sizeRecentre({
			liquidity,
			sqrtPriceX96,
			current: { tickLower: -2_000, tickUpper: -1_000 },
			proposed: { tickLower: 1_000, tickUpper: 2_000 },
			...pool,
			slippageBps: 0,
		})
		expect(s.withdrawn.amount0).toBe(0n)
		expect(s.liquidityToMint).toBe(0n)
	})

	test('with a pool to swap through, an out-of-range position funds a two-sided range', () => {
		const s = sizeRecentre({
			liquidity,
			sqrtPriceX96,
			current: { tickLower: 100, tickUpper: 1_100 },
			proposed,
			...deep,
			slippageBps: 50,
		})
		expect(s.zeroForOne).toBe(true)
		expect(s.amountIn).toBeGreaterThan(0n)
		expect(s.amountIn).toBeLessThan(s.withdrawn.amount0)
		expect(s.liquidityToMint).toBeGreaterThan(0n)
		// The price after the swap stays inside the new range, where the vault's limit would stop it anyway.
		expect(s.sqrtPriceAfter).toBeGreaterThanOrEqual(getSqrtRatioAtTick(proposed.tickLower))
		expect(s.sqrtPriceAfter).toBeLessThan(sqrtPriceX96)
		expect(s.amount0Max).toBe(s.withdrawn.amount0 - s.amountIn)
		expect(s.amount1Max).toBeGreaterThan(0n)
		expect(s.minAmountOut).toBe((s.amount1Max * 9_950n) / 10_000n)
		affordable(s)
	})

	test('above its range it sells token1, and the price moves up but not past the new upper edge', () => {
		const s = sizeRecentre({
			liquidity,
			sqrtPriceX96,
			current: { tickLower: -2_000, tickUpper: -1_000 },
			proposed,
			...deep,
			slippageBps: 50,
		})
		expect(s.zeroForOne).toBe(false)
		expect(s.withdrawn.amount0).toBe(0n)
		expect(s.amountIn).toBeLessThan(s.withdrawn.amount1)
		expect(s.sqrtPriceAfter).toBeGreaterThan(sqrtPriceX96)
		expect(s.sqrtPriceAfter).toBeLessThan(getSqrtRatioAtTick(proposed.tickUpper))
		expect(s.liquidityToMint).toBeGreaterThan(0n)
		affordable(s)
	})

	test('the swap is balanced: neither side is left far in excess', () => {
		const s = sizeRecentre({
			liquidity,
			sqrtPriceX96,
			current: { tickLower: 100, tickUpper: 1_100 },
			proposed,
			...deep,
			slippageBps: 0,
		})
		const l0 =
			(s.amount0Max * s.sqrtPriceAfter * getSqrtRatioAtTick(440)) /
			((1n << 96n) * (getSqrtRatioAtTick(440) - s.sqrtPriceAfter))
		const l1 = (s.amount1Max * (1n << 96n)) / (s.sqrtPriceAfter - getSqrtRatioAtTick(-560))
		const larger = l0 > l1 ? l0 : l1
		const smaller = l0 > l1 ? l1 : l0
		expect(larger - smaller).toBeLessThan(larger / 1_000n)
		expect(s.liquidityToMint).toBe(smaller)
	})

	test('a thin pool means a small swap and a small mint, never a price pushed out of the range', () => {
		const thin = sizeRecentre({
			liquidity,
			sqrtPriceX96,
			current: { tickLower: 100, tickUpper: 1_100 },
			proposed,
			poolLiquidity: 10n ** 12n,
			feePips: 500,
			slippageBps: 0,
		})
		const rich = sizeRecentre({
			liquidity,
			sqrtPriceX96,
			current: { tickLower: 100, tickUpper: 1_100 },
			proposed,
			...deep,
			slippageBps: 0,
		})
		expect(thin.amountIn).toBeLessThan(rich.amountIn)
		expect(thin.liquidityToMint).toBeLessThan(rich.liquidityToMint)
		expect(thin.sqrtPriceAfter).toBeGreaterThanOrEqual(getSqrtRatioAtTick(proposed.tickLower))
	})

	test('a higher fee costs liquidity, and the slippage scale is applied to what is minted', () => {
		const cheap = sizeRecentre({
			liquidity,
			sqrtPriceX96,
			current: { tickLower: 100, tickUpper: 1_100 },
			proposed,
			...deep,
			slippageBps: 0,
		})
		const dear = sizeRecentre({
			liquidity,
			sqrtPriceX96,
			current: { tickLower: 100, tickUpper: 1_100 },
			proposed,
			poolLiquidity: 10n ** 18n,
			feePips: 200_000,
			slippageBps: 0,
		})
		const cautious = sizeRecentre({
			liquidity,
			sqrtPriceX96,
			current: { tickLower: 100, tickUpper: 1_100 },
			proposed,
			...deep,
			slippageBps: 50,
		})
		expect(dear.liquidityToMint).toBeLessThan(cheap.liquidityToMint)
		expect(cautious.liquidityToMint).toBeLessThan(cheap.liquidityToMint)
		expect(cautious.amount0Min).toBe((cautious.withdrawn.amount0 * 9_950n) / 10_000n)
	})
})
