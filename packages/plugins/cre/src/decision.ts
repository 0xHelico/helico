import type { Mandate } from './mandate'

export type Position = {
	tickLower: number
	tickUpper: number
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
				| 'drift below threshold'
	  }
	| { act: true; tickLower: number; tickUpper: number; driftTicks: number }

// Uniswap tick bounds. The vault must snap with the same rule or the two will disagree.
const MIN_TICK = -887272
const MAX_TICK = 887272

/** Rounds to the nearest multiple of the spacing, clamped to the protocol's range. */
export function nearestUsableTick(tick: number, tickSpacing: number): number {
	const rounded = Math.round(tick / tickSpacing) * tickSpacing
	if (rounded < MIN_TICK) return rounded + tickSpacing
	if (rounded > MAX_TICK) return rounded - tickSpacing
	return rounded
}

export type DecisionInput = {
	/** The pool's current tick. */
	tick: number
	tickSpacing: number
	position: Position
	mandate: Pick<Mandate, 'rangeWidthBps' | 'minImprovementBps' | 'cooldownSeconds' | 'expiry'>
	/** Unix seconds. */
	now: number
}

/**
 * Whether to re-centre, and where. One tick is one basis point of price, so ticks out of
 * range are the drift in bps and `minImprovementBps` is the user's own cost floor. Pure.
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
	const driftTicks =
		tick < position.tickLower ? position.tickLower - tick : tick - position.tickUpper + 1
	if (driftTicks < mandate.minImprovementBps) return { act: false, reason: 'drift below threshold' }
	const half = Math.floor(mandate.rangeWidthBps / 2)
	const tickLower = nearestUsableTick(tick - half, tickSpacing)
	let tickUpper = nearestUsableTick(tick + half, tickSpacing)
	if (tickUpper <= tickLower) tickUpper = tickLower + tickSpacing
	return { act: true, tickLower, tickUpper, driftTicks }
}
