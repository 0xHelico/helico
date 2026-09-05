import { describe, expect, test } from 'bun:test'
import {
	decideRecentre,
	nearestUsableTick,
	type VaultRejection,
	type Verdict,
	vaultRejects,
} from './decision'

const mandate = {
	rangeWidthTicks: 1000,
	minImprovementBps: 50,
	cooldownSeconds: 3600,
	expiry: 2_000,
	minRetainedBps: 9000,
}
const position = { tickLower: 0, tickUpper: 1000, lastActionAt: 0 }
const base = { tickSpacing: 10, position, mandate, now: 1_000 }

describe('decideRecentre', () => {
	test.each([
		['holds once the mandate expired', { ...base, tick: 5_000, now: 2_000 }, 'mandate expired'],
		[
			'holds during the cooldown',
			{ ...base, tick: 5_000, position: { ...position, lastActionAt: 900 } },
			'cooldown',
		],
		['holds while in range (lower edge inclusive)', { ...base, tick: 0 }, 'in range'],
		[
			'holds while in range (upper edge exclusive, so 999 is inside)',
			{ ...base, tick: 999 },
			'in range',
		],
	])('%s', (_, input, reason) => {
		expect(decideRecentre(input)).toEqual({ act: false, reason } as Verdict)
	})

	test('re-centres on the tick with exactly the committed width, snapped to the spacing', () => {
		expect(decideRecentre({ ...base, tick: 1_234 })).toEqual({
			act: true,
			tickLower: 730,
			tickUpper: 1_730,
		})
	})

	test('re-centres on the low side too', () => {
		expect(decideRecentre({ ...base, tick: -60 })).toEqual({
			act: true,
			tickLower: -560,
			tickUpper: 440,
		})
	})

	test('one tick past the upper edge is enough: the vault measures the gap to the centre, not the drift', () => {
		expect(decideRecentre({ ...base, tick: 1_000 })).toEqual({
			act: true,
			tickLower: 500,
			tickUpper: 1_500,
		})
	})

	test('holds when the vault would find the improvement too small', () => {
		// A 99.99% shrink is only possible when the new centre lands exactly on the tick.
		const strict = { ...mandate, minImprovementBps: 9_999 }
		expect(decideRecentre({ ...base, tick: 1_234, mandate: strict })).toEqual({
			act: false,
			reason: 'vault would reject: NotEnoughImprovement',
		})
		expect(decideRecentre({ ...base, tick: 1_230, mandate: strict })).toEqual({
			act: true,
			tickLower: 730,
			tickUpper: 1_730,
		})
	})

	test('an odd width centres by flooring the half: spacing 1, width 3, tick 1234 gives [1233, 1236)', () => {
		expect(
			decideRecentre({
				...base,
				tick: 1_234,
				tickSpacing: 1,
				mandate: { ...mandate, rangeWidthTicks: 3 },
			}),
		).toEqual({ act: true, tickLower: 1_233, tickUpper: 1_236 })
	})

	test('the cooldown is over exactly at lastActionAt + cooldownSeconds', () => {
		const now = 10_000
		const live = { ...base, now, mandate: { ...mandate, expiry: 20_000 }, tick: 1_234 }
		const acted = { ...position, lastActionAt: now - 3_600 }
		expect(decideRecentre({ ...live, position: acted }).act).toBe(true)
		expect(
			decideRecentre({ ...live, position: { ...acted, lastActionAt: acted.lastActionAt + 1 } }),
		).toEqual({
			act: false,
			reason: 'cooldown',
		})
	})

	test('holds instead of emitting a width the vault would reject', () => {
		expect(
			decideRecentre({ ...base, tick: 5_000, mandate: { ...mandate, rangeWidthTicks: 1_005 } }),
		).toEqual({
			act: false,
			reason: 'vault would reject: TicksNotSpaced',
		})
	})

	test('every verdict it emits passes the vault, and it never holds when the vault would accept', () => {
		let acted = 0
		for (const tickSpacing of [1, 10, 60, 200]) {
			for (const widthInSpacings of [1, 2, 3, 10]) {
				const rangeWidthTicks = tickSpacing * widthInSpacings
				for (const minImprovementBps of [0, 50, 5_000, 9_999]) {
					const m = { ...mandate, rangeWidthTicks, minImprovementBps }
					const current = { tickLower: -rangeWidthTicks, tickUpper: 0, lastActionAt: 0 }
					for (let tick = -6_000; tick <= 6_000; tick += 7) {
						const verdict = decideRecentre({
							tick,
							tickSpacing,
							position: current,
							mandate: m,
							now: 1_000,
						})
						if (verdict.act) {
							acted++
							expect(
								vaultRejects({ tick, tickSpacing, current, proposed: verdict, mandate: m }),
							).toBeNull()
						} else if (widthInSpacings >= 2 && minImprovementBps <= 5_000) {
							const outside = tick < current.tickLower || tick >= current.tickUpper
							if (outside)
								throw new Error(
									`false hold at tick ${tick}, spacing ${tickSpacing}, width ${rangeWidthTicks}: ${verdict.reason}`,
								)
						}
					}
				}
			}
		}
		expect(acted).toBeGreaterThan(10_000)
	})
})

describe('vaultRejects', () => {
	const m = { rangeWidthTicks: 1000, minImprovementBps: 50 }
	const current = { tickLower: 0, tickUpper: 1000 }

	test('accepts an improvement exactly at the threshold, as the vault does (<=, not <)', () => {
		// gapNow = 1400 - 500 = 900; with 50% required, gapNext may be at most 450: centre 950 passes, 940 does not.
		const half = { rangeWidthTicks: 1000, minImprovementBps: 5_000 }
		expect(
			vaultRejects({
				tick: 1_400,
				tickSpacing: 10,
				current,
				proposed: { tickLower: 450, tickUpper: 1_450 },
				mandate: half,
			}),
		).toBeNull()
		expect(
			vaultRejects({
				tick: 1_400,
				tickSpacing: 10,
				current,
				proposed: { tickLower: 440, tickUpper: 1_440 },
				mandate: half,
			}),
		).toBe('NotEnoughImprovement')
	})

	test('the upper edge is exclusive: a tick equal to tickUpper is off market', () => {
		expect(
			vaultRejects({
				tick: 1_500,
				tickSpacing: 10,
				current,
				proposed: { tickLower: 500, tickUpper: 1_500 },
				mandate: m,
			}),
		).toBe('RangeOffMarket')
		expect(
			vaultRejects({
				tick: 1_499,
				tickSpacing: 10,
				current,
				proposed: { tickLower: 500, tickUpper: 1_500 },
				mandate: m,
			}),
		).toBeNull()
	})

	test.each([
		['unordered ticks', { tickLower: 1000, tickUpper: 1000 }, 'TicksNotOrdered'],
		['ticks off the spacing', { tickLower: 1005, tickUpper: 2005 }, 'TicksNotSpaced'],
		['wrong width', { tickLower: 1000, tickUpper: 1990 }, 'RangeWidthMismatch'],
		[
			'range that does not contain the tick',
			{ tickLower: 1510, tickUpper: 2510 },
			'RangeOffMarket',
		],
		['range no closer than the old one', { tickLower: 1000, tickUpper: 2000 }, null],
	])('%s', (_, proposed, expected) => {
		expect(vaultRejects({ tick: 1_500, tickSpacing: 10, current, proposed, mandate: m })).toBe(
			expected as VaultRejection | null,
		)
	})

	test('centres truncate toward zero, as in Solidity', () => {
		// The current centre is trunc(-3 / 2) = -1, where floor would give -2. At tick -1 the gap is
		// already 0, so the proposal cannot improve on it; with floor it would look like a 1-tick gain.
		expect(
			vaultRejects({
				tick: -1,
				tickSpacing: 1,
				current: { tickLower: -3, tickUpper: 0 },
				proposed: { tickLower: -2, tickUpper: 0 },
				mandate: { rangeWidthTicks: 2, minImprovementBps: 0 },
			}),
		).toBe('NotEnoughImprovement')
	})
})

describe('nearestUsableTick', () => {
	test.each([
		[1_234, 10, 1_230],
		[1_235, 10, 1_240],
		[-65, 10, -60],
		[-887_275, 10, -887_270],
		[887_275, 10, 887_270],
	])('rounds %d at spacing %d to %d', (tick, spacing, expected) => {
		expect(nearestUsableTick(tick, spacing)).toBe(expected)
	})
})
