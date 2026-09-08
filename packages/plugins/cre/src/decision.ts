import { BPS_DENOMINATOR, type IdlePolicy } from './policy'

/** What the account is worth right now, and what the market is paying for it. */
export type IdleBalances = {
	/** The asset the account holds liquid, in the asset's own units. */
	idle: bigint
	/** What the same account has at the venue, read from the receipt token. */
	supplied: bigint
	/** Aave's `currentLiquidityRate`, a ray. Only ever a reason not to supply. */
	supplyRateRay: bigint
}

export type HoldReason =
	| 'policy expired'
	| 'the account holds nothing to place'
	| 'already at the target split'
	| 'inside the deadband'
	| 'the venue pays below the policy floor'

export type Verdict =
	| { act: false; reason: HoldReason }
	| {
			act: true
			/** True moves capital into the market, false brings it back. */
			supply: boolean
			amount: bigint
			/**
			 * Carried out of the decision because it has to be applied again after the move is
			 * clamped to what the venue can actually do. See `index.ts`.
			 */
			deadband: bigint
	  }

export type TargetSplit = {
	total: bigint
	/** What the policy wants sitting liquid in the account. */
	wantIdle: bigint
	/** What it wants earning at the venue. */
	wantWorking: bigint
	/** Positive: supply this much. Negative: withdraw this much. Zero: already there. */
	delta: bigint
	/** The smallest move worth making at this size of account. */
	deadband: bigint
}

const BPS = BigInt(BPS_DENOMINATOR)
const max = (a: bigint, b: bigint): bigint => (a > b ? a : b)
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b)

/**
 * Where the policy says the two sides should sit, and how far off they are. Pure.
 *
 * The buffer is a floor under the idle side rather than a second target, so when
 * `minIdleAmount` and `targetWorkingBps` disagree the buffer wins. That ordering is the whole
 * reason this is not just a percentage: the account has to be able to cover a swap against its
 * Aqua mandate out of what it holds, and a mandate that cannot be covered fails at the moment it
 * is taken, which costs more than the yield that was missed by holding the buffer.
 */
export function targetSplit(policy: IdlePolicy, { idle, supplied }: IdleBalances): TargetSplit {
	const total = idle + supplied
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
		// at the venue. Neither bound needs to be applied again, and applying it would be code
		// nothing can reach.
		delta: idle - wantIdle,
		deadband: max(policy.minMoveAmount, (total * BigInt(policy.minMoveBps)) / BPS),
	}
}

export type DecisionInput = {
	policy: IdlePolicy
	balances: IdleBalances
	/** Unix seconds. */
	now: number
}

/**
 * Whether to move idle capital, which way, and how much. Pure.
 *
 * **The deadband is the point of this function.** The target split is almost never exactly met —
 * interest accrues every block, so `supplied` drifts upward continuously and a rule that
 * corrected every difference would send a transaction on every run for a few basis points. Gas
 * is paid per move and yield is earned per unit-second, so a correction that is smaller than
 * what it costs to make is worse than doing nothing, and the only way to say that is a number
 * the move has to clear before it happens.
 *
 * There is no cooldown here, and its absence is deliberate rather than forgotten: `HelicoAccount`
 * stores no timestamp of its last move, so the enclave has nothing to read one from. What limits
 * the rate instead is the cron schedule the workflow runs on, and the deadband — which, unlike a
 * cooldown, gets *harder* to clear the closer the account already is to its target.
 */
export function decideIdleMove({ policy, balances, now }: DecisionInput): Verdict {
	if (now >= policy.expiry) return { act: false, reason: 'policy expired' }

	const split = targetSplit(policy, balances)
	if (split.total === 0n) return { act: false, reason: 'the account holds nothing to place' }
	if (split.delta === 0n) return { act: false, reason: 'already at the target split' }

	const supply = split.delta > 0n
	const amount = supply ? split.delta : -split.delta
	if (amount < split.deadband) return { act: false, reason: 'inside the deadband' }
	// Checked after the deadband so a rate that has fallen is not blamed for a move that was
	// never going to happen. It gates supplying only: idle capital earns nothing at all, so a
	// poor rate is a reason to stop adding, never a reason to come back out.
	if (supply && balances.supplyRateRay < policy.minSupplyRateRay)
		return { act: false, reason: 'the venue pays below the policy floor' }

	return { act: true, supply, amount, deadband: split.deadband }
}
