import { type Address, parseAbi } from 'viem'

/** The `Mandate` struct as the vault declares it, field for field and width for width. */
const MANDATE_TUPLE =
	'(bytes32 poolId, uint16 rangeWidthTicks, uint16 minImprovementBps, uint32 cooldownSeconds, uint128 maxLiquidity, uint64 expiry, uint16 minRetainedBps)'

/**
 * What the enclave reads and what a person's wallet calls. The reads came first; the writes and
 * the errors are here because the app needs them, and one ABI is the only way the two stay
 * describing the same contract.
 *
 * The errors matter as much as the functions: without them a rejected `setMandate` reaches the
 * user as an unreadable revert, when the contract went to the trouble of saying exactly which
 * rule was broken.
 */
export const vaultAbi = parseAbi([
	'function positionOf(address owner) view returns (uint256)',
	'function lastActionAt(address owner) view returns (uint64)',
	'function isActive(address owner) view returns (bool)',
	'function nonces(address owner) view returns (uint256)',
	`function mandateOf(address owner) view returns (${MANDATE_TUPLE})`,
	`function setMandate(uint256 tokenId, ${MANDATE_TUPLE} m)`,
	'function revoke()',
	'event MandateSet(address indexed owner, uint256 indexed tokenId, bytes32 mandateHash)',
	'event Revoked(address indexed owner, uint256 indexed tokenId)',
	'error NotPositionOwner()',
	'error MandateInactive()',
	'error MandateExpired()',
	'error MandateAlreadyActive(uint256 tokenId)',
	'error PoolNotPermitted()',
	'error RangeWidthZero()',
	'error RangeWidthNotSpaced()',
	'error MaxLiquidityZero()',
	'error ImprovementOutOfRange()',
	'error RetentionOutOfRange()',
	'error CooldownZero()',
])

export const positionManagerAbi = parseAbi([
	'function getPositionLiquidity(uint256 tokenId) view returns (uint128)',
	'function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, uint256 info)',
])

export const stateViewAbi = parseAbi([
	'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
	'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
])

/** The vault's own struct, in its own order; the report carries it verbatim. */
export const recenterParamsAbi = {
	type: 'tuple',
	components: [
		{ name: 'owner', type: 'address' },
		{ name: 'tickLower', type: 'int24' },
		{ name: 'tickUpper', type: 'int24' },
		{ name: 'liquidityToMint', type: 'uint256' },
		{ name: 'amount0Min', type: 'uint128' },
		{ name: 'amount1Min', type: 'uint128' },
		{ name: 'amount0Max', type: 'uint128' },
		{ name: 'amount1Max', type: 'uint128' },
		{ name: 'zeroForOne', type: 'bool' },
		{ name: 'amountIn', type: 'uint256' },
		{ name: 'minAmountOut', type: 'uint256' },
		{ name: 'deadline', type: 'uint256' },
	],
} as const

/** The vault's `RecenterParams`, mirrored field for field. */
export type RecenterParams = {
	owner: Address
	tickLower: number
	tickUpper: number
	liquidityToMint: bigint
	amount0Min: bigint
	amount1Min: bigint
	amount0Max: bigint
	amount1Max: bigint
	zeroForOne: boolean
	amountIn: bigint
	minAmountOut: bigint
	deadline: bigint
}
