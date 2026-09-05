import { parseAbi } from 'viem'

export const positionManagerAbi = parseAbi([
	'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
	'function multicall(bytes[] data) payable returns (bytes[] results)',
	'function modifyLiquidities(bytes unlockData, uint256 deadline) payable',
	'function initializePool(PoolKey key, uint160 sqrtPriceX96) payable returns (int24)',
])
