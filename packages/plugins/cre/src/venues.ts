import { type Address, zeroAddress } from 'viem'
import type { VenueState } from './chain'

/**
 * A market this run may actually use, carrying the three numbers the decision compares.
 *
 * Everything the account itself would refuse has already been taken out by `eligibleVenues`, so
 * nothing downstream has to ask again whether a move against one of these would revert.
 */
export type Venue = {
	pool: Address
	/** The account's position at this market, in the asset's units. */
	supplied: bigint
	/** What this market can pay out right now. Caps a withdrawal; a supply adds to it. */
	venueLiquidity: bigint
	/** Aave's `currentLiquidityRate`, a ray. */
	supplyRateRay: bigint
}

/** Why a market the config named is not one of this run's candidates. */
export type VenueRefusal =
	| 'the owner has not permitted this venue'
	| 'the venue does not list this asset'
	| "the venue's receipt is for a different asset"

export type SkippedVenue = { pool: Address; reason: VenueRefusal }

/**
 * A market the owner has revoked while the account still has capital in it, and how much of that
 * capital the market can hand back right now.
 *
 * Separate from `Venue` because it is not a candidate for anything — nothing ranks it, nothing
 * compares its rate. It is one instruction with an address and an amount.
 */
export type Evacuation = { pool: Address; amount: bigint }

/**
 * The markets this run may use, and why the others were left out. Pure.
 *
 * The three refusals are the ones the account itself would enforce, checked here so a market that
 * cannot be moved against ends as a candidate that was skipped rather than as a transaction that
 * reverts. The receipt check is the exception: the account does not make it, and it is the one
 * that stops an amount denominated in one asset being spent out of a balance denominated in
 * another.
 *
 * **A venue that fails one of them is skipped and not fatal**, which is the rule `_venueFor`
 * follows in `HelicoMandateSwap`: ending the search at the first market that cannot serve this
 * account strands a usable one further down the list.
 *
 * What a skipped venue takes with it is its position, and that is deliberate: it is not capital
 * this run may place, so counting it towards the target split would set a working share against
 * money the split cannot move, and the account would hold forever waiting to correct a difference
 * it has no way to correct.
 *
 * **A revoked venue holding capital comes back as an evacuation rather than a skip.** Revoking is
 * how an owner says they want out, so the useful response is to leave, not to stand beside the
 * money and refuse. `withdrawIdle` is gated on `venueEverPermitted`, which a revoke does not
 * clear, so the agent can still unwind what it can no longer supply. The other two refusals get
 * no such treatment — without a receipt, or with one for another asset, there is no position here
 * this run can name.
 */
export function eligibleVenues(
	asset: string,
	venues: VenueState[],
): { usable: Venue[]; skipped: SkippedVenue[]; evacuate: Evacuation[] } {
	const usable: Venue[] = []
	const skipped: SkippedVenue[] = []
	const evacuate: Evacuation[] = []
	for (const venue of venues) {
		const reason = refusalFor(asset, venue)
		if (reason) {
			skipped.push({ pool: venue.pool, reason })
			if (reason === 'the owner has not permitted this venue' && listsThisAsset(asset, venue)) {
				// What the market can pay today, not what is owed. A drained market gets whatever
				// it has now and the rest on the next run, which is better than one refusal.
				const available =
					venue.supplied < venue.venueLiquidity ? venue.supplied : venue.venueLiquidity
				if (available > 0n) evacuate.push({ pool: venue.pool, amount: available })
			}
			continue
		}
		usable.push({
			pool: venue.pool,
			supplied: venue.supplied,
			venueLiquidity: venue.venueLiquidity,
			supplyRateRay: venue.supplyRateRay,
		})
	}
	return { usable, skipped, evacuate }
}

const listsThisAsset = (asset: string, venue: VenueState): boolean =>
	venue.receipt !== zeroAddress && venue.receiptAsset.toLowerCase() === asset.toLowerCase()

const refusalFor = (asset: string, venue: VenueState): VenueRefusal | undefined => {
	if (!venue.venuePermitted) return 'the owner has not permitted this venue'
	if (!listsThisAsset(asset, venue))
		return venue.receipt === zeroAddress
			? 'the venue does not list this asset'
			: "the venue's receipt is for a different asset"
	return undefined
}

/**
 * The market paying the most, or nothing at all when the list is empty.
 *
 * A tie goes to the earlier entry, which is the order the owner wrote in the config. Rates move
 * every block and two markets are rarely equal to the last unit of a ray, but when they are there
 * is no reason to prefer either — and picking arbitrarily would have the account migrate on a tie
 * that reverses next run.
 */
export function bestPaying(venues: Venue[]): Venue | undefined {
	let best: Venue | undefined
	for (const venue of venues) {
		if (!best || venue.supplyRateRay > best.supplyRateRay) best = venue
	}
	return best
}

/**
 * The worst-paying market that holds capital and can hand back at least `atLeast` of it.
 *
 * **Two conditions and not one**, for the reason the contract states about `_venueFor`: a market
 * can be deep and still unable to serve this account, because the position may be somewhere else
 * — and a market can hold the position and be drained. Ranking by rate alone lands on a venue
 * that cannot pay, and strands a funded one further down the list.
 *
 * `atLeast` is what the caller has to clear to be worth a transaction — the deadband for an
 * ordinary withdrawal, the round-trip bar for a migration. Passing it in rather than filtering
 * afterwards is what makes the ranking skip a venue too small to serve this move instead of
 * choosing it and then refusing the move it made impossible.
 */
export function worstFunded(venues: Venue[], atLeast: bigint): Venue | undefined {
	let worst: Venue | undefined
	for (const venue of venues) {
		const available = venue.supplied < venue.venueLiquidity ? venue.supplied : venue.venueLiquidity
		if (available === 0n || available < atLeast) continue
		if (!worst || venue.supplyRateRay < worst.supplyRateRay) worst = venue
	}
	return worst
}
