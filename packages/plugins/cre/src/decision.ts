import { BPS_DENOMINATOR, type IdlePolicy } from './policy'
import { bestPaying, type Venue, worstFunded } from './venues'

/** What the account is worth right now, and what each market is paying for it. */
export type IdleBalances = {
	/** The asset the account holds liquid, in the asset's own units. */
	idle: bigint
	/** Every market this run may use, already filtered by `eligibleVenues`. */
	venues: Venue[]
}

export type HoldReason =
	| 'policy expired'
	| 'no permitted venue lists this asset'
	| 'the account holds nothing to place'
	| 'already at the target split'
	| 'inside the deadband'
	| 'every venue pays below the policy floor'
	| 'no venue can return enough to be worth a move'

export type Verdict =
	| { act: false; reason: HoldReason }
	| {
			act: true
			/** True moves capital into a market, false brings it back. */
			supply: boolean
			/** Which market the move is against. Chosen by rate, never assumed. */
			venue: Venue
			amount: bigint
			/**
			 * Carried out of the decision because it has to be applied again after the move is
			 * clamped to what the venue can actually do. See `index.ts`. A migration carries the
			 * round-trip bar here rather than the ordinary deadband, so the second check holds it
			 * to the same standard as the first.
			 */
			deadband: bigint
	  }

export type TargetSplit = {
	total: bigint
	/** What the policy wants sitting liquid in the account. */
	wantIdle: bigint
	/** What it wants earning, across every market it may use. */
	wantWorking: bigint
	/** Positive: supply this much. Negative: withdraw this much. Zero: already there. */
	delta: bigint
	/** The smallest move worth making at this size of account. */
	deadband: bigint
}

const BPS = BigInt(BPS_DENOMINATOR)
const RAY = 10n ** 27n
const max = (a: bigint, b: bigint): bigint => (a > b ? a : b)
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b)

/** What the account has working, summed over the markets this run may use. */
export const suppliedTotal = (venues: Venue[]): bigint =>
	venues.reduce((sum, venue) => sum + venue.supplied, 0n)

/**
 * Where the policy says the two sides should sit, and how far off they are. Pure.
 *
 * The buffer is a floor under the idle side rather than a second target, so when
 * `minIdleAmount` and `targetWorkingBps` disagree the buffer wins. That ordering is the whole
 * reason this is not just a percentage: the account has to be able to cover a swap against its
 * Aqua mandate out of what it holds, and a mandate that cannot be covered fails at the moment it
 * is taken, which costs more than the yield that was missed by holding the buffer. Which
 * mandates raise the floor is decided upstream, in `withMandateBuffer` and the demand query: the
 * ones on apps that pull the asset from the wallet do; the ones on apps that unwind a venue
 * inside the swap (`coveringApps`) do not.
 *
 * The working side is the sum across markets, not one market's position. Where that capital
 * should sit is a separate question from how much of it should be working, and this answers only
 * the second.
 */
export function targetSplit(policy: IdlePolicy, balances: IdleBalances): TargetSplit {
	const idle = balances.idle
	const total = idle + suppliedTotal(balances.venues)
	const wantIdle = min(
		total,
		max(policy.minIdleAmount, total - (total * BigInt(policy.targetWorkingBps)) / BPS),
	)
	return {
		total,
		wantIdle,
		wantWorking: total - wantIdle,
		// `wantIdle` is clamped into [0, total], so this lands in [-supplied, idle]: a supply can
		// never ask for more than the account holds, and a withdrawal never for more than it has
		// across every market. Neither bound needs to be applied again. What it does *not* bound
		// is a single market's position — see `decideIdleMove`, which clamps to the one it picks.
		delta: idle - wantIdle,
		deadband: max(policy.minMoveAmount, (total * BigInt(policy.minMoveBps)) / BPS),
	}
}

/**
 * What a migration has to clear that a rebalance does not, and where both halves come from.
 *
 * **No new secret.** Moving capital from one market to a better one is a withdrawal and then a
 * supply — two transactions, across two runs, because `HelicoAccount.nonce` is strictly
 * sequential and one signed statement authorises exactly one call. So it has to clear a higher
 * bar than a move that pays gas once, and both numbers for that bar are already in the policy.
 *
 * **The size half is about gas, so it doubles.** `minMoveAmount` is the owner saying what one
 * transaction's gas is worth in this asset. A round trip pays it twice, so a migration has to be
 * worth twice what a rebalance has to be worth. That is the whole derivation; nothing else about
 * the deadband changes.
 *
 * **The rate half is about churn, and size cannot do it.** A large enough balance clears any size
 * bar on a one-basis-point difference, and then the account migrates back the first time the two
 * rates cross. The gap itself has to clear something, and the only figure in the policy
 * denominated in basis points is `minMoveBps` — the owner's own answer to "how small a difference
 * is not worth a transaction", asked of the account's size rather than of a rate. Reading it as
 * basis points *of rate* is a reuse, and it is stated here rather than hidden: a policy that
 * refuses to move less than 0.5% of the account also refuses to chase less than 0.5 percentage
 * points of yield.
 *
 * Neither half is a yield model, and pretending otherwise would be the dishonest kind of claim.
 * Pricing a migration properly needs a holding period — gas is paid once and the gain accrues per
 * unit-second — and nothing in the policy names one.
 */
export const roundTripDeadband = (deadband: bigint): bigint => deadband * 2n

/** `minMoveBps` read as basis points of rate: 50 bps of churn floor is 0.5 points of yield. */
export const rateGapFloor = (policy: IdlePolicy): bigint => (RAY * BigInt(policy.minMoveBps)) / BPS

export type DecisionInput = {
	policy: IdlePolicy
	balances: IdleBalances
	/** Unix seconds. */
	now: number
}

/**
 * Whether to move idle capital, which way, how much, and at which market. Pure.
 *
 * **The deadband is the point of this function.** The target split is almost never exactly met —
 * interest accrues every block, so the working side drifts upward continuously and a rule that
 * corrected every difference would send a transaction on every run for a few basis points. Gas
 * is paid per move and yield is earned per unit-second, so a correction that is smaller than
 * what it costs to make is worse than doing nothing, and the only way to say that is a number
 * the move has to clear before it happens.
 *
 * **One move leaves per run**, whichever branch produces it, because `HelicoAccount.nonce` is
 * strictly sequential: one signed statement authorises exactly one call. That is what makes a
 * migration two runs — the worse market is emptied now and the better one is filled next time,
 * by the ordinary supply branch, which will pick the best market on the numbers it reads then
 * rather than on the ones read here.
 *
 * There is no cooldown here, and its absence is deliberate rather than forgotten: `HelicoAccount`
 * stores no timestamp of its last move, so the enclave has nothing to read one from. What limits
 * the rate instead is the cron schedule the workflow runs on, and the deadband — which, unlike a
 * cooldown, gets *harder* to clear the closer the account already is to its target.
 */
export function decideIdleMove({ policy, balances, now }: DecisionInput): Verdict {
	if (now >= policy.expiry) return { act: false, reason: 'policy expired' }

	// The best market is read first because every branch below needs it, and because its absence
	// is the one condition under which there is nothing to decide at all.
	const best = bestPaying(balances.venues)
	if (!best) return { act: false, reason: 'no permitted venue lists this asset' }

	const split = targetSplit(policy, balances)
	if (split.total === 0n) return { act: false, reason: 'the account holds nothing to place' }

	const supplying = split.delta > 0n
	const wanted = supplying ? split.delta : -split.delta

	if (wanted >= split.deadband) {
		if (supplying) {
			// Checked after the deadband so a rate that has fallen is not blamed for a move that
			// was never going to happen. It gates supplying only: idle capital earns nothing at
			// all, so a poor rate is a reason to stop adding, never a reason to come back out.
			if (best.supplyRateRay < policy.minSupplyRateRay)
				return { act: false, reason: 'every venue pays below the policy floor' }
			return { act: true, supply: true, venue: best, amount: wanted, deadband: split.deadband }
		}
		// Liquidity is needed, so it comes out of the market paying least for it. The split knows
		// what the account has working in total and not how it is spread, so the withdrawal is
		// bounded again by what this one market holds.
		const source = worstFunded(balances.venues, split.deadband)
		if (!source) return { act: false, reason: 'no venue can return enough to be worth a move' }
		return {
			act: true,
			supply: false,
			venue: source,
			amount: min(wanted, source.supplied),
			deadband: split.deadband,
		}
	}

	// The split is met, or as near it as is worth correcting. What is left to ask is whether the
	// capital is sitting in the right place — and if it is not, this run empties the worse market
	// and the next one fills the better.
	return migrateOut(policy, balances, split, best) ?? nothingToDo(split)
}

const nothingToDo = (split: TargetSplit): Verdict => ({
	act: false,
	reason: split.delta === 0n ? 'already at the target split' : 'inside the deadband',
})

/**
 * The withdrawal leg of a migration, or `undefined` when the difference does not pay for one.
 *
 * The destination is not named in the move and does not need to be: the account is being emptied
 * of a position that pays too little, and the supply branch will place the proceeds at whatever
 * is best on the next run. What the destination has to do here is exist and clear the policy's
 * rate floor, because a migration towards a market the policy would refuse to supply to is a
 * withdrawal that strands the capital idle.
 */
function migrateOut(
	policy: IdlePolicy,
	balances: IdleBalances,
	split: TargetSplit,
	best: Venue,
): Verdict | undefined {
	if (best.supplyRateRay < policy.minSupplyRateRay) return undefined

	const bar = roundTripDeadband(split.deadband)
	const source = worstFunded(balances.venues, bar)
	if (!source || source.pool === best.pool) return undefined

	// Equal rates are not an improvement, and `rateGapFloor` is zero for a policy that turned its
	// relative half off — so the strict comparison is what stops such a policy migrating back and
	// forth between two markets paying the same.
	const gap = best.supplyRateRay - source.supplyRateRay
	if (gap === 0n || gap < rateGapFloor(policy)) return undefined

	return { act: true, supply: false, venue: source, amount: source.supplied, deadband: bar }
}
