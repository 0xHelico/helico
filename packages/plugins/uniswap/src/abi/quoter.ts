import { parseAbi } from 'viem'

export const quoterAbi = parseAbi([
	'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
	'struct PathKey { address intermediateCurrency; uint24 fee; int24 tickSpacing; address hooks; bytes hookData; }',
	'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
	'struct QuoteExactParams { address exactCurrency; PathKey[] path; uint128 exactAmount; }',
	'function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)',
	'function quoteExactOutputSingle(QuoteExactSingleParams params) returns (uint256 amountIn, uint256 gasEstimate)',
	'function quoteExactInput(QuoteExactParams params) returns (uint256 amountOut, uint256 gasEstimate)',
	'function quoteExactOutput(QuoteExactParams params) returns (uint256 amountIn, uint256 gasEstimate)',
])
