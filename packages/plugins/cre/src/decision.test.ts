import { describe, expect, test } from 'bun:test'
import type { Address } from 'viem'
import {
	decideIdleMove,
	type HoldReason,
	rateGapFloor,
	roundTripDeadband,
	targetSplit,
	type Verdict,
} from './decision'
import type { IdlePolicy } from './policy'
import type { Venue } from './venues'

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

/** Aave v3 on Arbitrum, and a second market. Nothing in the decision depends on which one. */
const AAVE = '0x794a61358D6845594F94dc1DB02A252b5b4814aD' as Address
const OTHER = `0x${'22'.repeat(20)}` as Address

/** A rate as a ray, which is what `currentLiquidityRate` is: 1e27 is 100%, so 2.75% is 2.75e25. */
const percent = (pct: number): bigint => BigInt(Math.round(pct * 100)) * 10n ** 23n

/** Liquidity defaults to more than any test moves, so only the tests about it are about it. */
const venue = (
	pool: Address,
	supplied: number,
	supplyRateRay: bigint,
	liquidity = 10_000_000,
): Venue => ({
	pool,
	supplied: usdc(supplied),
	venueLiquidity: usdc(liquidity),
	supplyRateRay,
})

/** The single-market account this workflow started as: one venue, paying the live Aave rate. */
const at = (idle: number, supplied: number) => ({
	idle: usdc(idle),
	venues: [venue(AAVE, supplied, rate)],
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

	/** The working side is the sum across markets, not one market's position. */
	test('adds up what is working wherever it sits', () => {
		const split = targetSplit(policy, {
			idle: usdc(200),
			venues: [venue(AAVE, 300, rate), venue(OTHER, 500, rate)],
		})
		expect(split.total).toBe(usdc(1_000))
		expect(split.delta).toBe(0n)
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
	 * holds and a withdrawal never for more than it has working in total, by construction rather
	 * than by a clamp somewhere later. What it does *not* bound is one market's share of that.
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

	/** Every market the config named was refused, so there is nothing left to decide between. */
	test("holds when no venue survived the account's own rules", () => {
		expect(decideIdleMove({ policy, balances: { idle: usdc(1_000), venues: [] }, now })).toEqual({
			act: false,
			reason: 'no permitted venue lists this asset',
		})
	})

	test('supplies the excess when too much is sitting idle', () => {
		expect(decideIdleMove({ policy, balances: at(1_000, 0), now })).toEqual({
			act: true,
			supply: true,
			venue: venue(AAVE, 0, rate),
			amount: usdc(800),
			deadband: usdc(25),
		})
	})

	test('withdraws when the account has fallen below the buffer it needs to cover a swap', () => {
		expect(decideIdleMove({ policy, balances: at(10, 990), now })).toEqual({
			act: true,
			supply: false,
			venue: venue(AAVE, 990, rate),
			amount: usdc(190),
			deadband: usdc(25),
		})
	})

	/**
	 * The reason the deadband exists. Interest accrues every block, so the working side drifts
	 * upward continuously and the split is almost never exactly met; without a floor the workflow
	 * would send a transaction every run to correct a few dollars, and pay more in gas than the
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
			venue: venue(AAVE, 7_970_000, rate),
			amount: usdc(30_000),
			deadband: usdc(25),
		})
	})

	test('a move exactly at the deadband goes through: the floor is the smallest move allowed', () => {
		// 1,031.25 in total wants 206.25 idle; holding 231.25 is a 25 USDC correction exactly.
		const balances = { idle: 231_250_000n, venues: [venue(AAVE, 800, rate)] }
		const verdict = decideIdleMove({ policy, balances, now })
		expect(verdict).toMatchObject({ act: true, supply: true, amount: usdc(25) })
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
				reason: 'every venue pays below the policy floor',
			})
		})

		/** Idle capital earns nothing at all, so a poor rate is never a reason to come back out. */
		test('never blocks a withdrawal', () => {
			expect(decideIdleMove({ policy: strict, balances: at(10, 990), now })).toMatchObject({
				act: true,
				supply: false,
				amount: usdc(190),
			})
		})

		test('lets a rate exactly at the floor through', () => {
			const exact = { idle: usdc(1_000), venues: [venue(AAVE, 0, strict.minSupplyRateRay)] }
			expect(decideIdleMove({ policy: strict, balances: exact, now }).act).toBe(true)
		})

		/**
		 * The floor is measured against the market the capital would end up in, so one market
		 * paying too little does not stop the account using another that pays enough.
		 */
		test('one market below the floor does not close the others', () => {
			const balances = {
				idle: usdc(1_000),
				venues: [venue(AAVE, 0, percent(1)), venue(OTHER, 0, percent(4))],
			}
			expect(decideIdleMove({ policy: strict, balances, now })).toMatchObject({
				act: true,
				supply: true,
				venue: { pool: OTHER },
				amount: usdc(800),
			})
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
							verdict.supply ? balances.idle : verdict.venue.supplied,
						)
						expect(verdict.amount).toBeGreaterThanOrEqual(verdict.deadband)
					}
				}
			}
		}
		expect(acted).toBeGreaterThan(100)
	})
})

// ─── Several markets ─────────────────────────────────────────
describe('choosing between markets', () => {
	test('supplies to the best-paying market, not to the one already holding capital', () => {
		const balances = {
			idle: usdc(1_000),
			venues: [venue(AAVE, 100, percent(2)), venue(OTHER, 0, percent(5))],
		}
		expect(decideIdleMove({ policy, balances, now })).toMatchObject({
			act: true,
			supply: true,
			venue: { pool: OTHER },
		})
	})

	/**
	 * Two markets are rarely equal to the last unit of a ray, but when they are there is no
	 * reason to prefer either — and picking arbitrarily would migrate on a tie that reverses.
	 */
	test('a tie goes to the market the owner listed first', () => {
		const balances = {
			idle: usdc(1_000),
			venues: [venue(AAVE, 0, percent(3)), venue(OTHER, 0, percent(3))],
		}
		expect(decideIdleMove({ policy, balances, now })).toMatchObject({ venue: { pool: AAVE } })
	})

	test('takes liquidity out of the market paying least for it', () => {
		const balances = {
			idle: usdc(10),
			venues: [venue(AAVE, 500, percent(2)), venue(OTHER, 490, percent(5))],
		}
		expect(decideIdleMove({ policy, balances, now })).toMatchObject({
			act: true,
			supply: false,
			venue: { pool: AAVE },
			amount: usdc(190),
		})
	})

	/**
	 * The split knows what the account has working in total, not how it is spread. One move
	 * leaves per run, so a withdrawal takes what this market holds and the rest waits.
	 */
	test('a withdrawal is bounded by the position at the market it comes out of', () => {
		const balances = {
			idle: usdc(10),
			venues: [venue(AAVE, 50, percent(2)), venue(OTHER, 940, percent(5))],
		}
		expect(decideIdleMove({ policy, balances, now })).toMatchObject({
			supply: false,
			venue: { pool: AAVE },
			amount: usdc(50),
		})
	})

	/**
	 * The rule `_venueFor` states in the contract: ranking by rate alone lands on a market that
	 * cannot pay and strands a funded one further down the list.
	 */
	test('skips a drained market even though it is the one paying least', () => {
		const balances = {
			idle: usdc(10),
			venues: [venue(AAVE, 500, percent(2), 0), venue(OTHER, 490, percent(5))],
		}
		expect(decideIdleMove({ policy, balances, now })).toMatchObject({
			supply: false,
			venue: { pool: OTHER },
			amount: usdc(190),
		})
	})

	test('holds when the capital is needed and no market can hand back enough of it', () => {
		const balances = {
			idle: usdc(10),
			venues: [venue(AAVE, 500, percent(2), 0), venue(OTHER, 490, percent(5), 0)],
		}
		expect(decideIdleMove({ policy, balances, now })).toEqual({
			act: false,
			reason: 'no venue can return enough to be worth a move',
		})
	})
})

// ─── Migration ───────────────────────────────────────────────
/**
 * The account is where the policy wants it and the capital is still in the wrong place. Moving it
 * is a withdrawal now and a supply next run, because the account's nonce is strictly sequential
 * and one signed statement authorises exactly one call.
 */
describe('migrating between markets', () => {
	/** 1,000 in total, 200 idle: exactly the target split, so nothing to rebalance. */
	const spread = (aaveRate: number, otherRate: number, atAave = 400) => ({
		idle: usdc(200),
		venues: [
			venue(AAVE, atAave, percent(aaveRate)),
			venue(OTHER, 800 - atAave, percent(otherRate)),
		],
	})

	test('empties the worse market, and says nothing about the better one', () => {
		expect(decideIdleMove({ policy, balances: spread(2, 3), now })).toEqual({
			act: true,
			supply: false,
			venue: venue(AAVE, 400, percent(2)),
			amount: usdc(400),
			// Twice the ordinary 25, because this is the first of two moves.
			deadband: usdc(50),
		})
	})

	/**
	 * The whole reason a migration needs its own bar. A rebalance pays gas once and corrects a
	 * position; a migration pays twice and earns only the difference between two rates, so
	 * chasing a basis point across a large balance clears the size bar and is still a loss.
	 */
	test("refuses a rate gap under the policy's relative floor", () => {
		expect(decideIdleMove({ policy, balances: spread(2.9, 3), now })).toEqual({
			act: false,
			reason: 'already at the target split',
		})
		// 0.5 percentage points is `minMoveBps` read as basis points of rate, and it is the bar.
		expect(rateGapFloor(policy)).toBe(percent(0.5))
		expect(decideIdleMove({ policy, balances: spread(2.5, 3), now })).toMatchObject({ act: true })
		expect(decideIdleMove({ policy, balances: spread(2.51, 3), now })).toEqual({
			act: false,
			reason: 'already at the target split',
		})
	})

	/** Equal rates are not an improvement, whatever a policy with its relative half off says. */
	test('never migrates between markets paying the same', () => {
		const churny = { ...policy, minMoveBps: 0 }
		expect(rateGapFloor(churny)).toBe(0n)
		expect(decideIdleMove({ policy: churny, balances: spread(3, 3), now })).toEqual({
			act: false,
			reason: 'already at the target split',
		})
	})

	/**
	 * The size half of the round trip. `minMoveAmount` is the owner saying what one transaction's
	 * gas is worth in this asset; a migration pays it twice, so a position that clears it once and
	 * not twice stays where it is.
	 */
	test('a position too small for a round trip stays where it is', () => {
		expect(roundTripDeadband(usdc(25))).toBe(usdc(50))
		expect(decideIdleMove({ policy, balances: spread(2, 3, 50), now })).toMatchObject({
			act: true,
			amount: usdc(50),
			deadband: usdc(50),
		})
		expect(decideIdleMove({ policy, balances: spread(2, 3, 49), now })).toEqual({
			act: false,
			reason: 'already at the target split',
		})
		// And it is the round trip that refuses it, not the ordinary deadband: 49 clears that.
		expect(usdc(49)).toBeGreaterThan(targetSplit(policy, spread(2, 3, 49)).deadband)
	})

	/** A migration towards a market the policy would refuse to supply to strands the capital. */
	test('will not empty a market when nowhere left pays the policy floor', () => {
		const strict = { ...policy, minSupplyRateRay: percent(4) }
		expect(decideIdleMove({ policy: strict, balances: spread(2, 3), now })).toEqual({
			act: false,
			reason: 'already at the target split',
		})
	})

	/**
	 * A rebalance is the more urgent of the two: the buffer exists to cover a swap, and a
	 * migration only earns a difference. When both are available the ordinary move wins, and its
	 * own deadband is what it has to clear.
	 */
	test('a needed rebalance comes before a migration', () => {
		const balances = {
			idle: usdc(10),
			venues: [venue(AAVE, 500, percent(2)), venue(OTHER, 490, percent(5))],
		}
		expect(decideIdleMove({ policy, balances, now })).toMatchObject({
			supply: false,
			venue: { pool: AAVE },
			amount: usdc(190),
			deadband: usdc(25),
		})
	})

	/** A drained market cannot be migrated out of either, and is skipped rather than chosen. */
	test('skips a market it cannot actually withdraw from', () => {
		const balances = {
			idle: usdc(200),
			venues: [
				venue(AAVE, 400, percent(1), 0),
				venue(OTHER, 300, percent(2)),
				venue(`0x${'33'.repeat(20)}` as Address, 100, percent(5)),
			],
		}
		expect(decideIdleMove({ policy, balances, now })).toMatchObject({
			act: true,
			supply: false,
			venue: { pool: OTHER },
			amount: usdc(300),
		})
	})

	/** One market cannot be both the source and the destination of a move between markets. */
	test('does not migrate an account that only uses one market', () => {
		expect(decideIdleMove({ policy, balances: at(200, 800), now })).toEqual({
			act: false,
			reason: 'already at the target split',
		})
	})
})
