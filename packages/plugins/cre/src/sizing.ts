/**
 * What the target split asks for is not always what the account can do. This turns the one into
 * the other, and says which bound decided — because a move that was cut down is a different
 * event from a move that went through whole, and the deadband has to be applied again to the
 * number that will actually be sent.
 */
export type SizingInput = {
	/** True for `supplyIdle`, false for `withdrawIdle`. */
	supply: boolean
	/** What `decideIdleMove` asked for, already bounded by the side it comes out of. */
	amount: bigint
	/**
	 * What the market can pay out right now — Aave's virtual underlying balance, not the token
	 * balance of the receipt contract. Caps a withdrawal and nothing else: a supply adds to it.
	 */
	venueLiquidity: bigint
	/** The policy's ceiling on a single move. */
	maxMoveAmount: bigint
}

/** Which bound settled the amount, or `none` when the split got what it asked for. */
export type MoveLimit = 'none' | 'the venue liquidity' | 'the per-move ceiling'

export type Sizing = { amount: bigint; limitedBy: MoveLimit }

/**
 * Clamps the move to what is actually available. Pure.
 *
 * The ceiling is applied after the venue's liquidity, so when both bind the reported limit is
 * the one that is really in the way. That matters more than it looks: "the venue is drained" and
 * "your own ceiling is low" ask the owner for opposite things.
 */
export function sizeIdleMove({
	supply,
	amount,
	venueLiquidity,
	maxMoveAmount,
}: SizingInput): Sizing {
	let sized = amount
	let limitedBy: MoveLimit = 'none'

	if (!supply && venueLiquidity < sized) {
		sized = venueLiquidity
		limitedBy = 'the venue liquidity'
	}
	if (maxMoveAmount < sized) {
		sized = maxMoveAmount
		limitedBy = 'the per-move ceiling'
	}

	return { amount: sized, limitedBy }
}
