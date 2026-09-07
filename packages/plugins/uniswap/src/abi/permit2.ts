import { parseAbi } from 'viem'

export const permit2Abi = parseAbi([
	'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
	'function approve(address token, address spender, uint160 amount, uint48 expiration)',
])
