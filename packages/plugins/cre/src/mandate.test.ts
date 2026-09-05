import { describe, expect, test } from 'bun:test'
import { encodeAbiParameters, keccak256, parseAbiParameters } from 'viem'
import { MANDATE_SECRET_IDS, type Mandate, mandateFromSecrets, mandateHash } from './mandate'

const poolId = '0xea84630b1ccfd69145b791334c55a7d8be1565910cb6e290c489413c977fd9c5'
const mandate: Mandate = {
	poolId,
	rangeWidthTicks: 1000,
	minImprovementBps: 50,
	cooldownSeconds: 3600,
	maxLiquidity: 10n ** 18n,
	expiry: 1_800_000_000,
}

describe('mandateHash', () => {
	test('equals keccak256(abi.encode(Mandate)) with the struct laid out as a tuple', () => {
		const solidityStyle = keccak256(
			encodeAbiParameters(
				parseAbiParameters(
					'(bytes32 poolId, uint16 rangeWidthTicks, uint16 minImprovementBps, uint32 cooldownSeconds, uint128 maxLiquidity, uint64 expiry)',
				),
				[mandate],
			),
		)
		expect(mandateHash(mandate)).toBe(solidityStyle)
		expect(mandateHash(mandate)).toBe(
			'0x71df72a84aad31ddb66ad186d70927767ee26feededa7a4f9f64ae96b4c527e5',
		)
	})

	test('any field change changes the hash', () => {
		expect(mandateHash({ ...mandate, minImprovementBps: 51 })).not.toBe(mandateHash(mandate))
		expect(mandateHash({ ...mandate, expiry: mandate.expiry + 1 })).not.toBe(mandateHash(mandate))
	})
})

describe('mandateFromSecrets', () => {
	const secrets = {
		[MANDATE_SECRET_IDS.rangeWidthTicks]: { value: '1000' },
		[MANDATE_SECRET_IDS.minImprovementBps]: { value: '50' },
		[MANDATE_SECRET_IDS.cooldownSeconds]: { value: '3600' },
		[MANDATE_SECRET_IDS.maxLiquidity]: { value: '1000000000000000000' },
		[MANDATE_SECRET_IDS.expiry]: { value: '1800000000' },
	}

	test('rebuilds the mandate the hash was computed from', () => {
		expect(mandateFromSecrets(poolId, secrets)).toEqual(mandate)
	})

	test('rejects a missing or malformed secret instead of guessing', () => {
		const { MANDATE_EXPIRY: _, ...missing } = secrets
		expect(() => mandateFromSecrets(poolId, missing)).toThrow('MANDATE_EXPIRY')
		expect(() =>
			mandateFromSecrets(poolId, { ...secrets, MANDATE_MAX_LIQUIDITY: { value: '1e18' } }),
		).toThrow('MANDATE_MAX_LIQUIDITY')
	})
})
