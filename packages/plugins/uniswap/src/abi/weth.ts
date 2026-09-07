import { parseAbi } from 'viem'

/** WETH9: the same interface on every chain that has a canonical wrapped ETH. */
export const wethAbi = parseAbi([
	'function deposit() payable',
	'function withdraw(uint256 amount)',
	'function balanceOf(address owner) view returns (uint256)',
])
