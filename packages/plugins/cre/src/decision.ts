import type { Mandate } from './mandate'

export type Range = { tickLower: number; tickUpper: number }

export type Position = Range & {
	/** Unix seconds of the last action the vault accepted; 0 when there was none. */
	lastActionAt: number
}

export type Verdict =
	| {
			act: false
			reason:
				| 'mandate hash mismatch'
				| 'mandate expired'
				| 'cooldown'
				| 'in range'
				| `vault would reject: ${VaultRejection}`
	  }
	| { act: true; tickLower: number; tickUpper: number }

/** The vault's own error names, so a hold can be traced to the line that would revert. */
export type VaultRejection =
	| 'TicksNotOrdered'
	| 'TicksNotSpaced'
	| 'RangeWidthMismatch'
	| 'RangeOffMarket'
	| 'NotEnoughImprovement'

// Uniswap tick bounds. The vault must snap with the same rule or the two will disagree.
const MIN_TICK = -887272
const MAX_TICK = 887272
const BPS = 10_000n

/** Rounds to the nearest multiple of the spacing, clamped to the protocol's range. */
export function nearestUsableTick(tick: number, tickSpacing: number): number {
	const rounded = Math.round(tick / tickSpacing) * tickSpacing
	if (rounded < MIN_TICK) return rounded + tickSpacing
	if (rounded > MAX_TICK) return rounded - tickSpacing
	return rounded
}

// Solidity's int256 division truncates toward zero; Math.floor would differ on negative centres.
const centreOf = (r: Range): number => Math.trunc((r.tickLower + r.tickUpper) / 2)
const gapToCentre = (tick: number, r: Range): number => Math.abs(tick - centreOf(r))

export type VaultCheck = {
	tick: number
	tickSpacing: number
	current: Range
	proposed: Range
	mandate: Pick<Mandate, 'rangeWidthTicks' | 'minImprovementBps'>
}

/**
 * Mirrors `HelicoVault._checkRange` check for check. Returns why the vault would revert, or
 * null when it would accept. The contract is the source of truth; keep the two in step.
 */
export function vaultRejects({
	tick,
	tickSpacing,
	current,
	proposed,
	mandate,
}: VaultCheck): VaultRejection | null {
	if (proposed.tickLower >= proposed.tickUpper) return 'TicksNotOrdered'
	if (proposed.tickLower % tickSpacing !== 0 || proposed.tickUpper % tickSpacing !== 0)
		return 'TicksNotSpaced'
	if (proposed.tickUpper - proposed.tickLower !== mandate.rangeWidthTicks)
		return 'RangeWidthMismatch'
	if (tick < proposed.tickLower || tick >= proposed.tickUpper) return 'RangeOffMarket'
	const gapNow = BigInt(gapToCentre(tick, current))
	const gapNext = BigInt(gapToCentre(tick, proposed))
	if (gapNext >= gapNow) return 'NotEnoughImprovement'
	if (gapNext * BPS > gapNow * (BPS - BigInt(mandate.minImprovementBps)))
		return 'NotEnoughImprovement'
	return null
}

export type DecisionInput = {
	/** The pool's current tick. */
	tick: number
	tickSpacing: number
	position: Position
	mandate: Pick<Mandate, 'rangeWidthTicks' | 'minImprovementBps' | 'cooldownSeconds' | 'expiry'>
	/** Unix seconds. */
	now: number
}

/**
 * Whether to re-centre, and where. Policy first (expired, cooling down, or still earning: hold),
 * then a range of the committed width centred on the tick, emitted only if the vault would
 * accept it. Pure.
 */
export function decideRecentre({
	tick,
	tickSpacing,
	position,
	mandate,
	now,
}: DecisionInput): Verdict {
	if (now >= mandate.expiry) return { act: false, reason: 'mandate expired' }
	if (position.lastActionAt > 0 && now < position.lastActionAt + mandate.cooldownSeconds) {
		return { act: false, reason: 'cooldown' }
	}
	// A v4 position earns while tickLower <= tick < tickUpper.
	if (tick >= position.tickLower && tick < position.tickUpper)
		return { act: false, reason: 'in range' }

	// Exact width by construction; only the lower edge is snapped.
	const width = mandate.rangeWidthTicks
	const tickLower = nearestUsableTick(tick - Math.floor(width / 2), tickSpacing)
	const proposed = { tickLower, tickUpper: tickLower + width }

	const rejection = vaultRejects({ tick, tickSpacing, current: position, proposed, mandate })
	if (rejection) return { act: false, reason: `vault would reject: ${rejection}` }
	return { act: true, ...proposed }
}
