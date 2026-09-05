import { parseAbi } from 'viem'

export const vaultAbi = parseAbi([
	'function positionOf(address owner) view returns (uint256)',
	'function lastActionAt(address owner) view returns (uint64)',
	'function isActive(address owner) view returns (bool)',
])

export const positionManagerAbi = parseAbi([
	'function getPositionLiquidity(uint256 tokenId) view returns (uint128)',
	'function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, uint256 info)',
])

export const stateViewAbi = parseAbi([
	'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
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
		{ name: 'deadline', type: 'uint256' },
	],
} as const
