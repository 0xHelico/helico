import { describe, expect, test } from 'bun:test'
import { type Address, getAddress, zeroAddress } from 'viem'
import type { VenueState } from './chain'
import { bestPaying, eligibleVenues, type Venue, worstFunded } from './venues'

// Aave v3, USDC and aUSDC on Arbitrum One, verified 8 September 2026.
const AAVE = '0x794a61358D6845594F94dc1DB02A252b5b4814aD' as Address
const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' as Address
const AUSDC = '0x724dc807b04555b71ed48a6896b6F41593b8C637' as Address
const WBTC = '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f' as Address

/** A second market and the receipt it would issue. Which one it is changes nothing here. */
const OTHER = `0x${'22'.repeat(20)}` as Address
const OTHER_RECEIPT = `0x${'23'.repeat(20)}` as Address

const usdc = (whole: number): bigint => BigInt(whole) * 1_000_000n
const percent = (pct: number): bigint => BigInt(Math.round(pct * 100)) * 10n ** 23n

const state = (over: Partial<VenueState> = {}): VenueState => ({
	pool: AAVE,
	venuePermitted: true,
	receipt: AUSDC,
	receiptAsset: USDC,
	supplied: usdc(500),
	venueLiquidity: usdc(1_000_000),
	supplyRateRay: percent(2.75),
	...over,
})

const venue = (over: Partial<Venue> = {}): Venue => ({
	pool: AAVE,
	supplied: usdc(500),
	venueLiquidity: usdc(1_000_000),
	supplyRateRay: percent(2.75),
	...over,
})

describe('eligibleVenues', () => {
	test('keeps a market the owner permitted that lists this asset', () => {
		expect(eligibleVenues(USDC, [state()])).toEqual({
			usable: [venue()],
			skipped: [],
			evacuate: [],
		})
	})

	/**
	 * A revoked market is both at once: skipped, so nothing places capital there or counts it
	 * towards the split, and evacuated, so the position in it comes home. The two lists answer
	 * different questions and a revoked venue belongs on both.
	 */
	test('a revoked market the account is sitting in comes back as an evacuation', () => {
		const { usable, skipped, evacuate } = eligibleVenues(USDC, [state({ venuePermitted: false })])
		expect(usable).toEqual([])
		expect(skipped).toEqual([{ pool: AAVE, reason: 'the owner has not permitted this venue' }])
		expect(evacuate).toEqual([{ pool: AAVE, amount: usdc(500) }])
	})

	test('a revoked market holding nothing is only skipped', () => {
		const { evacuate } = eligibleVenues(USDC, [state({ venuePermitted: false, supplied: 0n })])
		expect(evacuate).toEqual([])
	})

	test('a drained revoked market gives back what it has, and the rest next run', () => {
		const { evacuate } = eligibleVenues(USDC, [
			state({ venuePermitted: false, venueLiquidity: usdc(120) }),
		])
		expect(evacuate).toEqual([{ pool: AAVE, amount: usdc(120) }])
	})

	/**
	 * The other two refusals get no evacuation, and that is not an oversight. Without a receipt,
	 * or with one for another asset, there is no position here this run can name — `supplied` was
	 * never read against this asset, so an amount built from it would be a number from nowhere.
	 */
	test.each([
		['no receipt', { receipt: zeroAddress as Address }],
		['a receipt for another asset', { receiptAsset: WBTC }],
	] as [string, Partial<VenueState>][])('a revoked market with %s is not evacuated', (_, over) => {
		const { evacuate } = eligibleVenues(USDC, [state({ venuePermitted: false, ...over })])
		expect(evacuate).toEqual([])
	})

	/**
	 * The three refusals the account itself would make, each of them per market. With one market
	 * they are the whole run; with several they take that market out and leave the rest.
	 */
	test.each([
		['the owner has not permitted this venue', { venuePermitted: false }],
		['the venue does not list this asset', { receipt: zeroAddress as Address }],
		["the venue's receipt is for a different asset", { receiptAsset: WBTC }],
	] as [string, Partial<VenueState>][])('skips a market because %s', (reason, over) => {
		const { usable, skipped } = eligibleVenues(USDC, [state(over)])
		expect(usable).toEqual([])
		expect(skipped).toEqual([{ pool: AAVE, reason: reason as never }])
	})

	/**
	 * A refused market takes its position out of the account's total, and that is deliberate:
	 * `withdrawIdle` would revert on the same allowlist, so counting it would set a target
	 * against money the agent has no way to move.
	 */
	test('a refused market leaves the others alone', () => {
		const { usable, skipped } = eligibleVenues(USDC, [
			state({ venuePermitted: false }),
			state({ pool: OTHER, receipt: OTHER_RECEIPT, supplied: usdc(700) }),
		])
		expect(usable).toEqual([venue({ pool: OTHER, supplied: usdc(700) })])
		expect(skipped).toEqual([{ pool: AAVE, reason: 'the owner has not permitted this venue' }])
	})

	/** Config lowercases its hex, and `eth_call` decodes to a checksummed address. */
	test('compares the receipt to the asset without regard to case', () => {
		expect(
			eligibleVenues(USDC.toLowerCase(), [state({ receiptAsset: getAddress(USDC) })]).usable,
		).toHaveLength(1)
	})

	test("keeps the owner's order, which is what breaks a tie later", () => {
		const { usable } = eligibleVenues(USDC, [
			state({ pool: OTHER, receipt: OTHER_RECEIPT }),
			state(),
		])
		expect(usable.map((v) => v.pool)).toEqual([OTHER, AAVE])
	})
})

describe('bestPaying', () => {
	test('names the market paying most', () => {
		const best = bestPaying([
			venue({ supplyRateRay: percent(2) }),
			venue({ pool: OTHER, supplyRateRay: percent(5) }),
		])
		expect(best?.pool).toBe(OTHER)
	})

	test('a tie goes to the earlier entry, so a run does not migrate on one', () => {
		const best = bestPaying([venue(), venue({ pool: OTHER })])
		expect(best?.pool).toBe(AAVE)
	})

	test('an empty list has no answer, rather than a made-up one', () => {
		expect(bestPaying([])).toBeUndefined()
	})
})

describe('worstFunded', () => {
	const drained = venue({ supplyRateRay: percent(1), venueLiquidity: 0n })
	const funded = venue({ pool: OTHER, supplyRateRay: percent(4) })

	test('names the market paying least, among those holding capital', () => {
		expect(worstFunded([venue({ supplyRateRay: percent(1) }), funded], 0n)?.pool).toBe(AAVE)
	})

	/**
	 * The rule the contract states about `_venueFor`: a market can be deep and hold nothing of
	 * this account's, or hold the position and be drained. Ranking by rate alone lands on one that
	 * cannot pay and strands a funded one further down the list.
	 */
	test('skips a market that cannot pay, however little it pays', () => {
		expect(worstFunded([drained, funded], 0n)?.pool).toBe(OTHER)
		expect(
			worstFunded([venue({ supplied: 0n, supplyRateRay: percent(1) }), funded], 0n)?.pool,
		).toBe(OTHER)
	})

	/**
	 * `atLeast` is what the caller has to clear to be worth a transaction. Passing it in is what
	 * makes the ranking skip a market too small to serve the move, instead of choosing it and then
	 * refusing the move it made impossible.
	 */
	test('skips a market that cannot cover what the move needs', () => {
		const small = venue({ supplyRateRay: percent(1), supplied: usdc(40) })
		expect(worstFunded([small, funded], usdc(50))?.pool).toBe(OTHER)
		expect(worstFunded([small, funded], usdc(40))?.pool).toBe(AAVE)
	})

	/** Liquidity binds as hard as the position does, and the smaller of the two is what counts. */
	test('measures what the market can actually hand back, not what it owes', () => {
		const shallow = venue({ supplyRateRay: percent(1), venueLiquidity: usdc(30) })
		expect(worstFunded([shallow, funded], usdc(50))?.pool).toBe(OTHER)
		expect(worstFunded([shallow, funded], usdc(30))?.pool).toBe(AAVE)
	})

	test('has no answer when every market is empty or drained', () => {
		expect(worstFunded([drained, venue({ supplied: 0n })], 0n)).toBeUndefined()
		expect(worstFunded([], 0n)).toBeUndefined()
	})
})
