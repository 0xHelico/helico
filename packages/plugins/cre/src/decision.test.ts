import { describe, expect, test } from 'bun:test'
import { decideRecentre, nearestUsableTick } from './decision'

const mandate = { rangeWidthBps: 1000, minImprovementBps: 50, cooldownSeconds: 3600, expiry: 2_000 }
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
		[
			'holds when the drift is below the improvement floor',
			{ ...base, tick: 1_040 },
			'drift below threshold',
		],
		[
			'holds when the drift is below the floor on the low side',
			{ ...base, tick: -49 },
			'drift below threshold',
		],
	])('%s', (_, input, reason) => {
		expect(decideRecentre(input)).toEqual({ act: false, reason })
	})

	test('re-centres on the tick with the mandated width, snapped to the spacing', () => {
		expect(decideRecentre({ ...base, tick: 1_234 })).toEqual({
			act: true,
			tickLower: 730,
			tickUpper: 1_730,
			driftTicks: 235,
		})
	})

	test('re-centres on the low side too', () => {
		expect(decideRecentre({ ...base, tick: -60 })).toEqual({
			act: true,
			tickLower: -560,
			tickUpper: 440,
			driftTicks: 60,
		})
	})

	test('a range narrower than the spacing still gets one full spacing', () => {
		const verdict = decideRecentre({
			...base,
			tick: 5_000,
			tickSpacing: 200,
			mandate: { ...mandate, rangeWidthBps: 100 },
		})
		expect(verdict).toEqual({ act: true, tickLower: 5_000, tickUpper: 5_200, driftTicks: 4_001 })
	})

	test('the upper edge is exclusive: the tick just past it counts as one tick of drift', () => {
		expect(
			decideRecentre({ ...base, tick: 1_000, mandate: { ...mandate, minImprovementBps: 1 } }),
		).toMatchObject({
			act: true,
			driftTicks: 1,
		})
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
