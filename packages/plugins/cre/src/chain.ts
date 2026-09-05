import { bytesToBase64, cre, ok, type TeeRuntime, text } from '@chainlink/cre-sdk'
import {
	type Address,
	decodeFunctionResult,
	encodeAbiParameters,
	encodeFunctionData,
	type Hex,
	keccak256,
} from 'viem'
import { positionManagerAbi, stateViewAbi, vaultAbi } from './abi'

export type Call = { to: Address; data: Hex }

/**
 * One JSON-RPC batch of `eth_call`s over the HTTP capability, from inside the enclave. Results
 * come back in call order; any error in the batch throws, since a partial view is worse than
 * no view.
 */
export function ethCallBatch(runtime: TeeRuntime<unknown>, rpcUrl: string, calls: Call[]): Hex[] {
	const body = JSON.stringify(
		calls.map((call, id) => ({ jsonrpc: '2.0', id, method: 'eth_call', params: [call, 'latest'] })),
	)
	const response = new cre.capabilities.HTTPClient()
		.sendRequest(runtime, {
			url: rpcUrl,
			method: 'POST',
			body: bytesToBase64(new TextEncoder().encode(body)),
			multiHeaders: { 'Content-Type': { values: ['application/json'] } },
		})
		.result()
	if (!ok(response)) throw new Error(`RPC returned status ${response.statusCode}`)
	const parsed: unknown = JSON.parse(text(response))
	if (!Array.isArray(parsed)) {
		throw new Error(`RPC did not answer the batch: ${JSON.stringify(parsed).slice(0, 200)}`)
	}
	const replies = parsed as { id: number; result?: Hex; error?: { message?: string } }[]
	return calls.map((_, id) => {
		const reply = replies.find((r) => r.id === id)
		if (!reply?.result)
			throw new Error(`eth_call ${id} failed: ${reply?.error?.message ?? 'no result'}`)
		return reply.result
	})
}

export type PoolKey = {
	currency0: Address
	currency1: Address
	fee: number
	tickSpacing: number
	hooks: Address
}

/** v4's canonical PoolId, and the value the vault hashes into the mandate. */
export const poolIdOf = (key: PoolKey): Hex =>
	keccak256(
		encodeAbiParameters(
			[
				{ type: 'address' },
				{ type: 'address' },
				{ type: 'uint24' },
				{ type: 'int24' },
				{ type: 'address' },
			],
			[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
		),
	)

const signExtend24 = (x: bigint): number => Number(x >= 1n << 23n ? x - (1n << 24n) : x)

/** v4 packs a position's range as `200 bits poolId | 24 tickUpper | 24 tickLower | 8 hasSubscriber`. */
export const unpackPositionInfo = (info: bigint): { tickLower: number; tickUpper: number } => ({
	tickLower: signExtend24((info >> 8n) & 0xffffffn),
	tickUpper: signExtend24((info >> 32n) & 0xffffffn),
})

export type Addresses = { vault: Address; positionManager: Address; stateView: Address }

export type ChainState = {
	tokenId: bigint
	lastActionAt: number
	active: boolean
	sqrtPriceX96: bigint
	tick: number
	/** The pool's current LP fee in pips; for a dynamic-fee pool this is the fee in force now. */
	lpFee: number
	/** The pool's active liquidity, what a swap trades against inside the current tick. */
	poolLiquidity: bigint
	liquidity: bigint
	tickLower: number
	tickUpper: number
	poolKey: PoolKey
}

/** Everything the decision needs, in two batches: the account and the pool, then the position. */
export function readChainState(
	runtime: TeeRuntime<unknown>,
	rpcUrl: string,
	{ vault, positionManager, stateView }: Addresses,
	owner: Address,
	poolId: Hex,
): ChainState {
	const [positionOf, lastActionAt, isActive, slot0, poolLiquidityHex] = ethCallBatch(
		runtime,
		rpcUrl,
		[
			{
				to: vault,
				data: encodeFunctionData({ abi: vaultAbi, functionName: 'positionOf', args: [owner] }),
			},
			{
				to: vault,
				data: encodeFunctionData({ abi: vaultAbi, functionName: 'lastActionAt', args: [owner] }),
			},
			{
				to: vault,
				data: encodeFunctionData({ abi: vaultAbi, functionName: 'isActive', args: [owner] }),
			},
			{
				to: stateView,
				data: encodeFunctionData({ abi: stateViewAbi, functionName: 'getSlot0', args: [poolId] }),
			},
			{
				to: stateView,
				data: encodeFunctionData({
					abi: stateViewAbi,
					functionName: 'getLiquidity',
					args: [poolId],
				}),
			},
		],
	) as [Hex, Hex, Hex, Hex, Hex]
	const tokenId = decodeFunctionResult({
		abi: vaultAbi,
		functionName: 'positionOf',
		data: positionOf,
	})
	const [sqrtPriceX96, tick, , lpFee] = decodeFunctionResult({
		abi: stateViewAbi,
		functionName: 'getSlot0',
		data: slot0,
	})

	const [liquidityHex, poolAndInfo] = ethCallBatch(runtime, rpcUrl, [
		{
			to: positionManager,
			data: encodeFunctionData({
				abi: positionManagerAbi,
				functionName: 'getPositionLiquidity',
				args: [tokenId],
			}),
		},
		{
			to: positionManager,
			data: encodeFunctionData({
				abi: positionManagerAbi,
				functionName: 'getPoolAndPositionInfo',
				args: [tokenId],
			}),
		},
	]) as [Hex, Hex]
	const [poolKey, info] = decodeFunctionResult({
		abi: positionManagerAbi,
		functionName: 'getPoolAndPositionInfo',
		data: poolAndInfo,
	})

	return {
		tokenId,
		lastActionAt: Number(
			decodeFunctionResult({ abi: vaultAbi, functionName: 'lastActionAt', data: lastActionAt }),
		),
		active: decodeFunctionResult({ abi: vaultAbi, functionName: 'isActive', data: isActive }),
		sqrtPriceX96,
		tick,
		lpFee,
		poolLiquidity: decodeFunctionResult({
			abi: stateViewAbi,
			functionName: 'getLiquidity',
			data: poolLiquidityHex,
		}),
		liquidity: decodeFunctionResult({
			abi: positionManagerAbi,
			functionName: 'getPositionLiquidity',
			data: liquidityHex,
		}),
		...unpackPositionInfo(info),
		poolKey,
	}
}
