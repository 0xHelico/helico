import { describe, expect, test } from 'bun:test'
import { sizeIdleMove } from './sizing'

const base = {
	amount: 800_000_000n,
	venueLiquidity: 29_318_183_885_841n,
	maxMoveAmount: 1_000_000_000_000n,
}

describe('sizeIdleMove', () => {
	test('leaves a move alone when nothing is in the way', () => {
		expect(sizeIdleMove({ ...base, supply: true })).toEqual({
			amount: 800_000_000n,
			limitedBy: 'none',
		})
		expect(sizeIdleMove({ ...base, supply: false })).toEqual({
			amount: 800_000_000n,
			limitedBy: 'none',
		})
	})

	/**
	 * A supply adds to the market's liquidity, so its own emptiness cannot bound it. Applying the
	 * cap in both directions would refuse to put money into exactly the market that most needs it.
	 */
	test('a supply is not capped by what the market can pay out', () => {
		expect(sizeIdleMove({ ...base, supply: true, venueLiquidity: 0n })).toEqual({
			amount: 800_000_000n,
			limitedBy: 'none',
		})
	})

	test('a withdrawal takes no more than the market can pay out right now', () => {
		expect(sizeIdleMove({ ...base, supply: false, venueLiquidity: 300_000_000n })).toEqual({
			amount: 300_000_000n,
			limitedBy: 'the venue liquidity',
		})
	})

	test('the per-move ceiling binds in both directions', () => {
		for (const supply of [true, false]) {
			expect(sizeIdleMove({ ...base, supply, maxMoveAmount: 50_000_000n })).toEqual({
				amount: 50_000_000n,
				limitedBy: 'the per-move ceiling',
			})
		}
	})

	/**
	 * Which bound is reported is not cosmetic: "the market is drained" and "your own ceiling is
	 * low" ask the owner for opposite things, so the one actually in the way has to win.
	 */
	test('when both bind, the tighter one is the one named', () => {
		expect(
			sizeIdleMove({
				...base,
				supply: false,
				venueLiquidity: 300_000_000n,
				maxMoveAmount: 50_000_000n,
			}),
		).toEqual({ amount: 50_000_000n, limitedBy: 'the per-move ceiling' })
		expect(
			sizeIdleMove({
				...base,
				supply: false,
				venueLiquidity: 50_000_000n,
				maxMoveAmount: 300_000_000n,
			}),
		).toEqual({ amount: 50_000_000n, limitedBy: 'the venue liquidity' })
	})

	test('a drained market sizes a withdrawal at nothing rather than at something impossible', () => {
		expect(sizeIdleMove({ ...base, supply: false, venueLiquidity: 0n })).toEqual({
			amount: 0n,
			limitedBy: 'the venue liquidity',
		})
	})

	test('never returns more than it was asked for, whatever the bounds are', () => {
		for (const amount of [0n, 1n, 10n ** 6n, 10n ** 12n]) {
			for (const venueLiquidity of [0n, 1n, 10n ** 9n, 10n ** 18n]) {
				for (const maxMoveAmount of [1n, 10n ** 6n, 10n ** 18n]) {
					for (const supply of [true, false]) {
						const sized = sizeIdleMove({ supply, amount, venueLiquidity, maxMoveAmount })
						expect(sized.amount).toBeLessThanOrEqual(amount)
						expect(sized.amount).toBeLessThanOrEqual(maxMoveAmount)
						if (!supply) expect(sized.amount).toBeLessThanOrEqual(venueLiquidity)
					}
				}
			}
		}
	})
})
