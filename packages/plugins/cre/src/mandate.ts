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
	/**
	 * The smallest share of the position's liquidity, in bps, that must survive a re-centre.
	 * Re-centring withdraws everything and mints again, and how much to mint is the agent's
	 * number; without this an agent can mint dust and send the rest to the owner's wallet.
	 * Zero permits that, explicitly. The vault rejects anything above 10,000.
	 */
	minRetainedBps: number
}

/**
 * The struct shaped the way viem wants it for a call: Solidity's uint64 and uint128 arrive and
 * leave as bigint. Keeping the conversion beside the type is the point — `expiry` as a JS number
 * is a seconds timestamp a person can read, and as a bigint it is what the contract stores, and
 * the pair of them silently disagreeing is a transaction that reverts for no visible reason.
 */
export const toContractMandate = (m: Mandate) => ({ ...m, expiry: BigInt(m.expiry) })

/** The inverse, for a `mandateOf` read. */
export const fromContractMandate = (m: Omit<Mandate, 'expiry'> & { expiry: bigint }): Mandate => ({
	...m,
	expiry: Number(m.expiry),
})

const MANDATE_ABI = [
	{ type: 'bytes32' },
	{ type: 'uint16' },
	{ type: 'uint16' },
	{ type: 'uint32' },
	{ type: 'uint128' },
	{ type: 'uint64' },
	{ type: 'uint16' },
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
			m.minRetainedBps,
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
	minRetainedBps: 'MANDATE_MIN_RETAINED_BPS',
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
		minRetainedBps: integer(read('minRetainedBps'), MANDATE_SECRET_IDS.minRetainedBps),
	}
}

/** The vault's own bound on anything measured in basis points. */
export const BPS = 10_000

/**
 * The reason `setMandate` would refuse this, or `undefined` if it would accept it.
 *
 * Every branch mirrors one `revert` in `HelicoVault.setMandate`, and returns that error's own
 * name — so a form can say why before asking anyone to pay gas to be told the same thing, and
 * the name it shows matches the one an explorer would decode from the failed transaction.
 *
 * It does not replace the contract's checks and cannot: ownership of the position and the pool
 * behind it are only knowable on chain. Passing this means the terms themselves are sound.
 */
export function mandateRefusedBecause(
	m: Mandate,
	{
		tickSpacing,
		nowSeconds = Math.floor(Date.now() / 1000),
	}: { tickSpacing: number; nowSeconds?: number },
): string | undefined {
	if (m.expiry <= nowSeconds) return 'MandateExpired'
	if (m.rangeWidthTicks === 0) return 'RangeWidthZero'
	if (m.maxLiquidity === 0n) return 'MaxLiquidityZero'
	if (m.minImprovementBps >= BPS) return 'ImprovementOutOfRange'
	if (m.minRetainedBps > BPS) return 'RetentionOutOfRange'
	// A zero cooldown lets an agent re-centre repeatedly in one block, each time paying the
	// pool's fee and the gas out of the position.
	if (m.cooldownSeconds === 0) return 'CooldownZero'
	// The width a user signs is the width they get: the vault refuses rather than snapping.
	if (tickSpacing <= 0 || m.rangeWidthTicks % tickSpacing !== 0) return 'RangeWidthNotSpaced'
	return undefined
}
