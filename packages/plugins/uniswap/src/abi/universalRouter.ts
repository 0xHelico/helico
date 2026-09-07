import { parseAbi } from 'viem'

export const universalRouterAbi = parseAbi([
	'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
])
