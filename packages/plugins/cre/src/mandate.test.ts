import { describe, expect, test } from 'bun:test'
import type { AbiFunction, AbiParameter } from 'viem'
import { encodeAbiParameters, keccak256, parseAbiParameters } from 'viem'
import { vaultAbi } from './abi'
import {
	fromContractMandate,
	MANDATE_SECRET_IDS,
	type Mandate,
	mandateFromSecrets,
	mandateHash,
	mandateRefusedBecause,
	toContractMandate,
} from './mandate'

const poolId = '0xea84630b1ccfd69145b791334c55a7d8be1565910cb6e290c489413c977fd9c5'
const mandate: Mandate = {
	poolId,
	rangeWidthTicks: 1000,
	minImprovementBps: 50,
	cooldownSeconds: 3600,
	maxLiquidity: 10n ** 18n,
	expiry: 1_800_000_000,
	minRetainedBps: 9000,
}

describe('mandateHash', () => {
	test('equals keccak256(abi.encode(Mandate)) with the struct laid out as a tuple', () => {
		const solidityStyle = keccak256(
			encodeAbiParameters(
				parseAbiParameters(
					'(bytes32 poolId, uint16 rangeWidthTicks, uint16 minImprovementBps, uint32 cooldownSeconds, uint128 maxLiquidity, uint64 expiry, uint16 minRetainedBps)',
				),
				[{ ...mandate, expiry: BigInt(mandate.expiry) }],
			),
		)
		expect(mandateHash(mandate)).toBe(solidityStyle)
		expect(mandateHash(mandate)).toBe(
			'0x134be6bb4e1c442551c22dfe96cb5b7c3c31babb386e2e9a051e57ee329a6225',
		)
	})

	test('any field change changes the hash', () => {
		expect(mandateHash({ ...mandate, minImprovementBps: 51 })).not.toBe(mandateHash(mandate))
		expect(mandateHash({ ...mandate, expiry: mandate.expiry + 1 })).not.toBe(mandateHash(mandate))
		expect(mandateHash({ ...mandate, minRetainedBps: 9001 })).not.toBe(mandateHash(mandate))
	})
})

describe('mandateFromSecrets', () => {
	const secrets = {
		[MANDATE_SECRET_IDS.rangeWidthTicks]: { value: '1000' },
		[MANDATE_SECRET_IDS.minImprovementBps]: { value: '50' },
		[MANDATE_SECRET_IDS.cooldownSeconds]: { value: '3600' },
		[MANDATE_SECRET_IDS.maxLiquidity]: { value: '1000000000000000000' },
		[MANDATE_SECRET_IDS.expiry]: { value: '1800000000' },
		[MANDATE_SECRET_IDS.minRetainedBps]: { value: '9000' },
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

describe('the vault ABI and the hash describe the same struct', () => {
	const tupleOf = (name: string, pick: (item: AbiFunction) => readonly AbiParameter[]) => {
		const item = vaultAbi.find((i) => i.type === 'function' && i.name === name) as
			| AbiFunction
			| undefined
		if (!item) throw new Error(`vaultAbi has no ${name}`)
		const [tuple] = pick(item)
		if (!tuple) throw new Error(`${name} has no tuple`)
		return tuple
	}
	const encoded = (tuple: AbiParameter) =>
		keccak256(encodeAbiParameters([tuple], [{ ...mandate, expiry: BigInt(mandate.expiry) }]))

	// Reordering or resizing a field in abi.ts would leave `mandateOf` decoding one struct while
	// the enclave hashes another, and nothing else in the repository would notice.
	test('what mandateOf returns hashes to what mandateHash produces', () => {
		expect(encoded(tupleOf('mandateOf', (i) => i.outputs))).toBe(mandateHash(mandate))
	})

	test('what setMandate accepts is that same struct', () => {
		expect(encoded(tupleOf('setMandate', (i) => i.inputs.slice(1)))).toBe(mandateHash(mandate))
	})
})

describe('the conversions to and from the contract', () => {
	test('a round trip through the contract shapes changes nothing', () => {
		expect(fromContractMandate(toContractMandate(mandate))).toEqual(mandate)
	})

	test('expiry crosses as a bigint, because that is what a uint64 is to viem', () => {
		expect(toContractMandate(mandate).expiry).toBe(BigInt(mandate.expiry))
	})
})

describe('mandateRefusedBecause', () => {
	// Spacing 10 divides 1000, so the fixture above is sound to begin with.
	const at = (over: Partial<Mandate> = {}, tickSpacing = 10) =>
		mandateRefusedBecause({ ...mandate, ...over }, { tickSpacing, nowSeconds: 1_700_000_000 })

	test('terms the vault would accept are not refused', () => {
		expect(at()).toBeUndefined()
	})

	test.each([
		['MandateExpired', { expiry: 1_600_000_000 }, 10],
		['RangeWidthZero', { rangeWidthTicks: 0 }, 10],
		['MaxLiquidityZero', { maxLiquidity: 0n }, 10],
		['ImprovementOutOfRange', { minImprovementBps: 10_000 }, 10],
		['RetentionOutOfRange', { minRetainedBps: 10_001 }, 10],
		['CooldownZero', { cooldownSeconds: 0 }, 10],
		['RangeWidthNotSpaced', {}, 60],
	] as [string, Partial<Mandate>, number][])(
		'names %s the way the contract does',
		(error, over, spacing) => {
			expect(at(over, spacing)).toBe(error)
		},
	)

	test('every name it can return is an error the ABI can decode', () => {
		const declared = new Set(
			vaultAbi.filter((i) => i.type === 'error').map((i) => (i as { name: string }).name),
		)
		for (const [over, spacing] of [
			[{ expiry: 1_600_000_000 }, 10],
			[{ rangeWidthTicks: 0 }, 10],
			[{ maxLiquidity: 0n }, 10],
			[{ minImprovementBps: 10_000 }, 10],
			[{ minRetainedBps: 10_001 }, 10],
			[{ cooldownSeconds: 0 }, 10],
			[{}, 60],
		] as [Partial<Mandate>, number][]) {
			expect(declared).toContain(at(over, spacing) as string)
		}
	})
})
