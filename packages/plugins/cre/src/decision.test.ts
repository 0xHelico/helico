import { describe, expect, test } from 'bun:test'
import { decideIdleMove, type HoldReason, targetSplit, type Verdict } from './decision'
import type { IdlePolicy } from './policy'

/**
 * Everything here is USDC, so six decimals: `100_000_000n` is 100 USDC. The policy wants 80% of
 * the account working, never less than 100 USDC liquid, and refuses to move less than 25 USDC or
 * less than 0.5% of the account.
 */
const usdc = (whole: number): bigint => BigInt(whole) * 1_000_000n

const policy: IdlePolicy = {
	targetWorkingBps: 8_000,
	minIdleAmount: usdc(100),
	minMoveAmount: usdc(25),
	minMoveBps: 50,
	minSupplyRateRay: 0n,
	maxMoveAmount: usdc(1_000_000),
	expiry: 2_000_000_000,
}

const now = 1_700_000_000
const rate = 27_514_566_416_591_863_466_760_475n // Aave USDC on Arbitrum, 8 September 2026: 2.75%
const at = (idle: number, supplied: number) => ({
	idle: usdc(idle),
	supplied: usdc(supplied),
	supplyRateRay: rate,
})

describe('targetSplit', () => {
	test('splits the whole account, whichever side the capital starts on', () => {
		for (const balances of [at(1_000, 0), at(0, 1_000), at(500, 500)]) {
			const split = targetSplit(policy, balances)
			expect(split.total).toBe(usdc(1_000))
			expect(split.wantIdle + split.wantWorking).toBe(split.total)
			expect(split.wantWorking).toBe(usdc(800))
		}
	})

	/**
	 * The buffer is a floor and not a second target, so it wins. A policy asking for 99% working
	 * on a 1,000 USDC account still leaves the 100 the owner said they need for a swap.
	 */
	test('the buffer beats the target share when the two disagree', () => {
		const greedy = { ...policy, targetWorkingBps: 9_900 }
		expect(targetSplit(greedy, at(1_000, 0)).wantIdle).toBe(usdc(100))
		expect(targetSplit(greedy, at(1_000, 0)).wantWorking).toBe(usdc(900))
	})

	/** An account smaller than its own buffer keeps all of it, rather than owing itself money. */
	test('an account below the buffer wants everything idle and nothing working', () => {
		const split = targetSplit(policy, at(40, 0))
		expect(split.wantIdle).toBe(usdc(40))
		expect(split.wantWorking).toBe(0n)
		expect(split.delta).toBe(0n)
	})

	test('the deadband is the larger of the two floors, and grows with the account', () => {
		expect(targetSplit(policy, at(1_000, 0)).deadband).toBe(usdc(25))
		expect(targetSplit(policy, at(10_000_000, 0)).deadband).toBe(usdc(50_000))
	})

	/**
	 * The bound the rest of the code relies on: a supply can never ask for more than the account
	 * holds and a withdrawal never for more than it has at the venue, by construction rather
	 * than by a clamp somewhere later.
	 */
	test('the difference never exceeds the side it would come out of', () => {
		for (const targetWorkingBps of [0, 1, 5_000, 9_999, 10_000]) {
			for (const minIdleAmount of [0n, usdc(1), usdc(100), usdc(10_000)]) {
				for (const idle of [0, 1, 99, 100, 5_000]) {
					for (const supplied of [0, 1, 100, 7_000]) {
						const p = { ...policy, targetWorkingBps, minIdleAmount }
						const { delta } = targetSplit(p, at(idle, supplied))
						expect(delta).toBeLessThanOrEqual(usdc(idle))
						expect(-delta).toBeLessThanOrEqual(usdc(supplied))
					}
				}
			}
		}
	})
})

describe('decideIdleMove', () => {
	test.each([
		['the policy has expired', at(1_000, 0), 2_000_000_000, 'policy expired'],
		['there is nothing to place', at(0, 0), now, 'the account holds nothing to place'],
		['the split is already met', at(200, 800), now, 'already at the target split'],
	] as [string, ReturnType<typeof at>, number, HoldReason][])(
		'holds when %s',
		(_, balances, when, reason) => {
			expect(decideIdleMove({ policy, balances, now: when })).toEqual({
				act: false,
				reason,
			} as Verdict)
		},
	)

	test('supplies the excess when too much is sitting idle', () => {
		expect(decideIdleMove({ policy, balances: at(1_000, 0), now })).toEqual({
			act: true,
			supply: true,
			amount: usdc(800),
			deadband: usdc(25),
		})
	})

	test('withdraws when the account has fallen below the buffer it needs to cover a swap', () => {
		expect(decideIdleMove({ policy, balances: at(10, 990), now })).toEqual({
			act: true,
			supply: false,
			amount: usdc(190),
			deadband: usdc(25),
		})
	})

	/**
	 * The reason the deadband exists. Interest accrues every block, so `supplied` drifts upward
	 * continuously and the split is almost never exactly met; without a floor the workflow would
	 * send a transaction every run to correct a few dollars, and pay more in gas than the
	 * correction is worth.
	 */
	test('holds on a drift smaller than the absolute floor', () => {
		// 1,010 in total wants 202 idle, and 210 is held: an 8 USDC correction, below the 25 floor.
		expect(decideIdleMove({ policy, balances: at(210, 800), now })).toEqual({
			act: false,
			reason: 'inside the deadband',
		})
	})

	/**
	 * The relative half, which only binds on a large account: 30,000 USDC clears the 25 USDC gas
	 * bar many times over and is still only 0.3% of a ten-million account, which is not a
	 * rebalance worth making.
	 */
	test('holds on a drift that clears the absolute floor but not the relative one', () => {
		const balances = at(2_030_000, 7_970_000)
		expect(decideIdleMove({ policy, balances, now })).toEqual({
			act: false,
			reason: 'inside the deadband',
		})
		expect(decideIdleMove({ policy: { ...policy, minMoveBps: 0 }, balances, now })).toEqual({
			act: true,
			supply: true,
			amount: usdc(30_000),
			deadband: usdc(25),
		})
	})

	test('a move exactly at the deadband goes through: the floor is the smallest move allowed', () => {
		// 1,031.25 in total wants 206.25 idle; holding 231.25 is a 25 USDC correction exactly.
		const balances = { ...at(0, 0), idle: 231_250_000n, supplied: usdc(800) }
		const verdict = decideIdleMove({ policy, balances, now })
		expect(verdict).toEqual({ act: true, supply: true, amount: usdc(25), deadband: usdc(25) })
		expect(decideIdleMove({ policy, balances: { ...balances, idle: 231_249_999n }, now })).toEqual({
			act: false,
			reason: 'inside the deadband',
		})
	})

	describe('the rate floor', () => {
		const strict = { ...policy, minSupplyRateRay: 30_000_000_000_000_000_000_000_000n } // 3%

		test('stops capital going to a market paying less than the owner asked for', () => {
			expect(decideIdleMove({ policy: strict, balances: at(1_000, 0), now })).toEqual({
				act: false,
				reason: 'the venue pays below the policy floor',
			})
		})

		/** Idle capital earns nothing at all, so a poor rate is never a reason to come back out. */
		test('never blocks a withdrawal', () => {
			expect(decideIdleMove({ policy: strict, balances: at(10, 990), now })).toEqual({
				act: true,
				supply: false,
				amount: usdc(190),
				deadband: usdc(25),
			})
		})

		test('lets a rate exactly at the floor through', () => {
			const exact = { ...at(1_000, 0), supplyRateRay: strict.minSupplyRateRay }
			expect(decideIdleMove({ policy: strict, balances: exact, now }).act).toBe(true)
		})
	})

	test('every move it emits fits inside the side it comes out of', () => {
		let acted = 0
		for (const targetWorkingBps of [0, 2_500, 8_000, 10_000]) {
			for (const minIdleAmount of [0n, usdc(100), usdc(5_000)]) {
				for (const idle of [0, 30, 300, 3_000, 30_000]) {
					for (const supplied of [0, 30, 300, 3_000, 30_000]) {
						const p = { ...policy, targetWorkingBps, minIdleAmount }
						const balances = at(idle, supplied)
						const verdict = decideIdleMove({ policy: p, balances, now })
						if (!verdict.act) continue
						acted++
						expect(verdict.amount).toBeGreaterThan(0n)
						expect(verdict.amount).toBeLessThanOrEqual(
							verdict.supply ? balances.idle : balances.supplied,
						)
						expect(verdict.amount).toBeGreaterThanOrEqual(verdict.deadband)
					}
				}
			}
		}
		expect(acted).toBeGreaterThan(100)
	})
})
