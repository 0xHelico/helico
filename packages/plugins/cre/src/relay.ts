import { encodeFunctionData, type Hex, parseAbiItem } from 'viem'
import type { Authorisation } from './sign'

const PARAMS =
	'(address owner, int24 tickLower, int24 tickUpper, uint256 liquidityToMint, uint128 amount0Min, uint128 amount1Min, uint128 amount0Max, uint128 amount1Max, bool zeroForOne, uint256 amountIn, uint256 minAmountOut, uint256 deadline)'

/**
 * Calldata for the vault's signature entry point, so a relayer has nothing to encode. The
 * function name is the caller's until the vault fixes it.
 */
export function encodeRecenterWithSignature(
	functionName: string,
	auth: Authorisation,
	signature: Hex,
): Hex {
	const item = parseAbiItem(
		`function ${functionName}(${PARAMS} p, bytes32 mandateHash, uint256 nonce, bytes signature)`,
	)
	return encodeFunctionData({
		abi: [item],
		functionName,
		args: [auth.params, auth.mandateHash, auth.nonce, signature],
	} as Parameters<typeof encodeFunctionData>[0])
}
