import { describe, expect, test } from 'bun:test'
import { type IdlePolicy, POLICY_SECRET_IDS, policyFromSecrets, policyHash } from './policy'

/** 80% working, 100 USDC of buffer, nothing under 25 USDC or 0.5% moves, 1M USDC per move. */
const policy: IdlePolicy = {
	targetWorkingBps: 8_000,
	minIdleAmount: 100_000_000n,
	minMoveAmount: 25_000_000n,
	minMoveBps: 50,
	minSupplyRateRay: 0n,
	maxMoveAmount: 1_000_000_000_000n,
	expiry: 2_000_000_000,
}

const secrets = {
	[POLICY_SECRET_IDS.targetWorkingBps]: { value: '8000' },
	[POLICY_SECRET_IDS.minIdleAmount]: { value: '100000000' },
	[POLICY_SECRET_IDS.minMoveAmount]: { value: '25000000' },
	[POLICY_SECRET_IDS.minMoveBps]: { value: '50' },
	[POLICY_SECRET_IDS.minSupplyRateRay]: { value: '0' },
	[POLICY_SECRET_IDS.maxMoveAmount]: { value: '1000000000000' },
	[POLICY_SECRET_IDS.expiry]: { value: '2000000000' },
}

describe('policyHash', () => {
	// cast abi-encode "f(uint16,uint256,uint256,uint16,uint256,uint256,uint64)" \
	//   8000 100000000 25000000 50 0 1000000000000 2000000000 | cast keccak
	test('is the keccak of the encoded fields, pinned to a vector produced by cast', () => {
		expect(policyHash(policy)).toBe(
			'0x63252eb3d00b4713a7ae923551b77107f12c2aa057b94494fda994b235499584',
		)
	})

	test('every field is in the hash, so none of them can be edited unnoticed', () => {
		const h = policyHash(policy)
		const variants: Partial<IdlePolicy>[] = [
			{ targetWorkingBps: 8_001 },
			{ minIdleAmount: 100_000_001n },
			{ minMoveAmount: 25_000_001n },
			{ minMoveBps: 51 },
			{ minSupplyRateRay: 1n },
			{ maxMoveAmount: 1_000_000_000_001n },
			{ expiry: 2_000_000_001 },
		]
		for (const over of variants) expect(policyHash({ ...policy, ...over })).not.toBe(h)
	})
})

describe('policyFromSecrets', () => {
	test('reads every field, and hashes to the same value the type does', () => {
		expect(policyFromSecrets(secrets)).toEqual(policy)
		expect(policyHash(policyFromSecrets(secrets))).toBe(policyHash(policy))
	})

	test.each([
		['a missing field', { ...secrets, [POLICY_SECRET_IDS.expiry]: undefined }, 'IDLE_EXPIRY'],
		[
			'an amount in scientific notation',
			{ ...secrets, [POLICY_SECRET_IDS.minIdleAmount]: { value: '1e8' } },
			'IDLE_MIN_IDLE_AMOUNT',
		],
		[
			'a negative amount',
			{ ...secrets, [POLICY_SECRET_IDS.minMoveAmount]: { value: '-1' } },
			'IDLE_MIN_MOVE_AMOUNT',
		],
	] as [string, Record<string, { value: string } | undefined>, string][])(
		'refuses %s instead of guessing',
		(_, broken, id) => {
			expect(() => policyFromSecrets(broken as Record<string, { value: string }>)).toThrow(id)
		},
	)

	/**
	 * The repair that looks sane — clamping to 10,000 — is the one that empties the buffer, and
	 * the buffer is the only thing keeping the account able to cover a swap. A share above 100%
	 * is a typo, and the only safe reading of a typo is to stop.
	 */
	test('refuses a share above 100% rather than clamping it', () => {
		expect(() =>
			policyFromSecrets({ ...secrets, [POLICY_SECRET_IDS.targetWorkingBps]: { value: '12000' } }),
		).toThrow('IDLE_TARGET_WORKING_BPS')
		expect(
			policyFromSecrets({ ...secrets, [POLICY_SECRET_IDS.targetWorkingBps]: { value: '10000' } })
				.targetWorkingBps,
		).toBe(10_000)
	})

	/** Zero could mean "never move" or "no ceiling", the two are opposites, so it means neither. */
	test('refuses a per-move ceiling of zero', () => {
		expect(() =>
			policyFromSecrets({ ...secrets, [POLICY_SECRET_IDS.maxMoveAmount]: { value: '0' } }),
		).toThrow('IDLE_MAX_MOVE_AMOUNT')
	})
})
