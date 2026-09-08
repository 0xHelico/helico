import { encodeAbiParameters, type Hex, keccak256 } from 'viem'

/**
 * The owner's idle-capital policy: how much of their stablecoin should be earning, how much must
 * stay liquid, and how large a difference is worth paying gas to correct.
 *
 * **Nothing on chain holds this.** `HelicoAccount` enforces the *shape* of what the agent may do
 * — money moves between the account and a market the owner allowlisted, and nowhere else — and
 * leaves *how much* and *when* to the enclave. That is the division the plan draws and the whole
 * Chainlink claim: the contract cannot be talked into paying a third party, and the strategy
 * that decides the amounts is never published.
 *
 * Amounts are in the asset's own units, not in dollars and not scaled. USDC has six decimals, so
 * 25 USDC is `25_000_000n`; getting that wrong is a thousand-fold error in either direction, and
 * there is nothing on chain to catch it.
 */
export type IdlePolicy = {
	/** The share of total capital that should be earning, in bps of `idle + supplied`. */
	targetWorkingBps: number
	/**
	 * The least that may be left liquid in the account, in the asset's units.
	 *
	 * This is a floor under the buffer, not a second target, and it wins over
	 * `targetWorkingBps` whenever the two disagree. The account has to be able to cover a swap
	 * against its Aqua mandate out of what it holds; a mandate that cannot be covered is a
	 * mandate that fails at the moment it is taken, which is worse than earning nothing.
	 */
	minIdleAmount: bigint
	/**
	 * The deadband, absolute half: no move smaller than this, in the asset's units.
	 *
	 * A supply or a withdrawal costs gas whatever it moves, so below some size the correction
	 * is worth less than making it. This is the number that says where that is.
	 */
	minMoveAmount: bigint
	/**
	 * The deadband, relative half: no move smaller than this share of total capital, in bps.
	 *
	 * The absolute half is about gas and the relative half is about churn, and they bind at
	 * different sizes of account. On a large balance a few dollars clears the gas bar easily
	 * and still is not worth a transaction; on a small one the gas bar is the only thing
	 * stopping the account rebalancing itself to death. A move has to clear both.
	 */
	minMoveBps: number
	/**
	 * The least the market may be paying before capital is sent to it, as Aave's
	 * `currentLiquidityRate`: a ray, so 1e27 is 100%. Zero turns the floor off.
	 *
	 * It gates supplying only. A rate that has fallen is not a reason to pull capital out,
	 * because idle capital earns nothing at all — it is only a reason not to add more.
	 */
	minSupplyRateRay: bigint
	/** Ceiling on a single move, in the asset's units. Bounds what one bad run can do. */
	maxMoveAmount: bigint
	/** Unix seconds after which the enclave stops acting for this account. */
	expiry: number
}

const POLICY_ABI = [
	{ type: 'uint16' },
	{ type: 'uint256' },
	{ type: 'uint256' },
	{ type: 'uint16' },
	{ type: 'uint256' },
	{ type: 'uint256' },
	{ type: 'uint64' },
] as const

/**
 * `keccak256(abi.encode(policy))`, in the field order of the type above.
 *
 * Unlike the vault's mandate hash this commits to nothing on chain, because the account stores
 * no policy — so it cannot be checked by a contract and is not a safety property. What it is
 * good for is the one thing the mandate hash was also good for: an owner can publish this hash,
 * and the enclave refuses to act when the secrets it was handed do not produce it. That catches
 * a policy edited underneath a running workflow. It does not catch an enclave that lies about
 * what it computed, and nothing off chain could.
 */
export function policyHash(p: IdlePolicy): Hex {
	return keccak256(
		encodeAbiParameters(POLICY_ABI, [
			p.targetWorkingBps,
			p.minIdleAmount,
			p.minMoveAmount,
			p.minMoveBps,
			p.minSupplyRateRay,
			p.maxMoveAmount,
			BigInt(p.expiry),
		]),
	)
}

/** Vault DON secret ids holding the policy. The account, the venue and the asset are public. */
export const POLICY_SECRET_IDS = {
	targetWorkingBps: 'IDLE_TARGET_WORKING_BPS',
	minIdleAmount: 'IDLE_MIN_IDLE_AMOUNT',
	minMoveAmount: 'IDLE_MIN_MOVE_AMOUNT',
	minMoveBps: 'IDLE_MIN_MOVE_BPS',
	minSupplyRateRay: 'IDLE_MIN_SUPPLY_RATE_RAY',
	maxMoveAmount: 'IDLE_MAX_MOVE_AMOUNT',
	expiry: 'IDLE_EXPIRY',
} as const

/** Anything measured in basis points is bounded by this, here as it is in the contracts. */
export const BPS_DENOMINATOR = 10_000

const bps = (raw: string | undefined, id: string): number => {
	const n = Number(raw)
	if (raw === undefined || !Number.isInteger(n) || n < 0 || n > BPS_DENOMINATOR)
		throw new Error(`Secret ${id} must be a whole number of basis points, 0 to ${BPS_DENOMINATOR}`)
	return n
}

const seconds = (raw: string | undefined, id: string): number => {
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

/**
 * A ceiling of zero is refused rather than read as "no ceiling", following `MaxLiquidityZero` in
 * the vault. Either reading is defensible and the two are opposites — one never moves anything,
 * the other moves everything — so the value that cannot say which is meant is rejected.
 */
const positive = (raw: string | undefined, id: string): bigint => {
	const n = unsigned(raw, id)
	if (n === 0n) throw new Error(`Secret ${id} must be greater than zero`)
	return n
}

/**
 * Builds the policy from the enclave's secrets, refusing anything out of range rather than
 * clamping it.
 *
 * A policy is not market data. A `targetWorkingBps` of 12,000 is not an unusual day, it is
 * somebody's typo, and the sane-looking repair — treating it as 10,000 — silently moves every
 * last unit of the buffer into the market. Failing here surfaces it on the first run.
 */
export function policyFromSecrets(secrets: Record<string, { value: string }>): IdlePolicy {
	const read = (key: keyof typeof POLICY_SECRET_IDS) => secrets[POLICY_SECRET_IDS[key]]?.value
	return {
		targetWorkingBps: bps(read('targetWorkingBps'), POLICY_SECRET_IDS.targetWorkingBps),
		minIdleAmount: unsigned(read('minIdleAmount'), POLICY_SECRET_IDS.minIdleAmount),
		minMoveAmount: unsigned(read('minMoveAmount'), POLICY_SECRET_IDS.minMoveAmount),
		minMoveBps: bps(read('minMoveBps'), POLICY_SECRET_IDS.minMoveBps),
		minSupplyRateRay: unsigned(read('minSupplyRateRay'), POLICY_SECRET_IDS.minSupplyRateRay),
		maxMoveAmount: positive(read('maxMoveAmount'), POLICY_SECRET_IDS.maxMoveAmount),
		expiry: seconds(read('expiry'), POLICY_SECRET_IDS.expiry),
	}
}
