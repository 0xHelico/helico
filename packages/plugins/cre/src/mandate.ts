import { encodeAbiParameters, type Hex, keccak256 } from 'viem'

/**
 * The user's policy, committed on-chain as `keccak256(abi.encode(mandate))` when the vault is
 * created. Field order and widths must match the vault's struct exactly; the hash is what ties
 * the enclave's decision to what the user signed.
 */
export type Mandate = {
	poolId: Hex
	/** Exact width of the range to re-centre into, in ticks; a whole number of the pool's spacings. */
	rangeWidthTicks: number
	/** How much closer to the market the range must move, in bps of the gap it already sits at. */
	minImprovementBps: number
	cooldownSeconds: number
	/** Ceiling on the liquidity `L` a single action may move. */
	maxLiquidity: bigint
	expiry: number
}

const MANDATE_ABI = [
	{ type: 'bytes32' },
	{ type: 'uint16' },
	{ type: 'uint16' },
	{ type: 'uint32' },
	{ type: 'uint128' },
	{ type: 'uint64' },
] as const

/** Same bytes as Solidity's `keccak256(abi.encode(Mandate))` for a static struct. */
export function mandateHash(m: Mandate): Hex {
	return keccak256(
		encodeAbiParameters(MANDATE_ABI, [
			m.poolId,
			m.rangeWidthTicks,
			m.minImprovementBps,
			m.cooldownSeconds,
			m.maxLiquidity,
			BigInt(m.expiry),
		]),
	)
}

/** Vault DON secret ids that hold the private half of the mandate. */
export const MANDATE_SECRET_IDS = {
	rangeWidthTicks: 'MANDATE_RANGE_WIDTH_TICKS',
	minImprovementBps: 'MANDATE_MIN_IMPROVEMENT_BPS',
	cooldownSeconds: 'MANDATE_COOLDOWN_SECONDS',
	maxLiquidity: 'MANDATE_MAX_LIQUIDITY',
	expiry: 'MANDATE_EXPIRY',
} as const

const integer = (raw: string | undefined, id: string): number => {
	const n = Number(raw)
	if (raw === undefined || !Number.isInteger(n) || n < 0)
		throw new Error(`Secret ${id} must be a non-negative integer`)
	return n
}

const unsigned = (raw: string | undefined, id: string): bigint => {
	if (raw === undefined || !/^\d+$/.test(raw))
		throw new Error(`Secret ${id} must be an unsigned integer`)
	return BigInt(raw)
}

/** Builds the mandate from the enclave's secrets plus the public pool id. */
export function mandateFromSecrets(
	poolId: Hex,
	secrets: Record<string, { value: string }>,
): Mandate {
	const read = (key: keyof typeof MANDATE_SECRET_IDS) => secrets[MANDATE_SECRET_IDS[key]]?.value
	return {
		poolId,
		rangeWidthTicks: integer(read('rangeWidthTicks'), MANDATE_SECRET_IDS.rangeWidthTicks),
		minImprovementBps: integer(read('minImprovementBps'), MANDATE_SECRET_IDS.minImprovementBps),
		cooldownSeconds: integer(read('cooldownSeconds'), MANDATE_SECRET_IDS.cooldownSeconds),
		maxLiquidity: unsigned(read('maxLiquidity'), MANDATE_SECRET_IDS.maxLiquidity),
		expiry: integer(read('expiry'), MANDATE_SECRET_IDS.expiry),
	}
}
