import { describe, expect, test } from 'bun:test'
import { getAmount0Delta, getAmount1Delta, getSqrtRatioAtTick } from './math'
import { sizeRecentre } from './sizing'

describe('sizeRecentre', () => {
	const sqrtPriceX96 = 78_971_408_793_868_239_585_893_302_751n // the live testnet pool, tick -65
	const liquidity = 10n ** 15n

	test('an out-of-range position holds one token, and one token buys no two-sided range', () => {
		// Below its range the old position is all token0. A range containing the price needs both
		// tokens, and the vault's burn-and-mint plan has no swap, so nothing can be minted.
		const s = sizeRecentre({
			liquidity,
			sqrtPriceX96,
			current: { tickLower: 100, tickUpper: 1_100 },
			proposed: { tickLower: -560, tickUpper: 440 },
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
			proposed: { tickLower: -560, tickUpper: 440 },
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
			proposed: { tickLower: -560, tickUpper: 440 },
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
			slippageBps: 0,
		})
		expect(s.withdrawn.amount0).toBe(0n)
		expect(s.liquidityToMint).toBe(0n)
	})
})
