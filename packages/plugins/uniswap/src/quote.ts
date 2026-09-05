import type { Address, Hex, PublicClient } from 'viem'
import { quoterAbi } from './abi/quoter'
import { addresses } from './addresses'
import { chainIdOf } from './client'
import type { PathKey, PoolKey } from './types'

const quoterOf = async (client: PublicClient) => addresses(await chainIdOf(client)).quoter

export type SingleHopQuoteInput = {
	poolKey: PoolKey
	zeroForOne: boolean
	hookData?: Hex
}

/** Output for an exact input through one pool. A read-only eth_call, nothing is sent. */
export async function quoteExactInputSingle(
	client: PublicClient,
	{ poolKey, zeroForOne, amountIn, hookData = '0x' }: SingleHopQuoteInput & { amountIn: bigint },
) {
	const { result } = await client.simulateContract({
		address: await quoterOf(client),
		abi: quoterAbi,
		functionName: 'quoteExactInputSingle',
		args: [{ poolKey, zeroForOne, exactAmount: amountIn, hookData }],
	})
	return { amountOut: result[0], gasEstimate: result[1] }
}

/** Input needed for an exact output through one pool. */
export async function quoteExactOutputSingle(
	client: PublicClient,
	{ poolKey, zeroForOne, amountOut, hookData = '0x' }: SingleHopQuoteInput & { amountOut: bigint },
) {
	const { result } = await client.simulateContract({
		address: await quoterOf(client),
		abi: quoterAbi,
		functionName: 'quoteExactOutputSingle',
		args: [{ poolKey, zeroForOne, exactAmount: amountOut, hookData }],
	})
	return { amountIn: result[0], gasEstimate: result[1] }
}

/** Output for an exact input along a multi-hop path that starts at `currencyIn`. */
export async function quoteExactInput(
	client: PublicClient,
	{ currencyIn, path, amountIn }: { currencyIn: Address; path: PathKey[]; amountIn: bigint },
) {
	const { result } = await client.simulateContract({
		address: await quoterOf(client),
		abi: quoterAbi,
		functionName: 'quoteExactInput',
		args: [{ exactCurrency: currencyIn, path, exactAmount: amountIn }],
	})
	return { amountOut: result[0], gasEstimate: result[1] }
}

/** Input needed for an exact output along a multi-hop path that ends at `currencyOut`. */
export async function quoteExactOutput(
	client: PublicClient,
	{ currencyOut, path, amountOut }: { currencyOut: Address; path: PathKey[]; amountOut: bigint },
) {
	const { result } = await client.simulateContract({
		address: await quoterOf(client),
		abi: quoterAbi,
		functionName: 'quoteExactOutput',
		args: [{ exactCurrency: currencyOut, path, exactAmount: amountOut }],
	})
	return { amountIn: result[0], gasEstimate: result[1] }
}
