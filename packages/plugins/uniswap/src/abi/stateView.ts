import { parseAbi } from 'viem'

export const stateViewAbi = parseAbi([
	'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
	'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
])
