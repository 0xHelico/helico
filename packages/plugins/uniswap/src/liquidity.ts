import { type Currency, Ether, Percent, Token } from '@uniswap/sdk-core'
import { encodeSqrtRatioX96 } from '@uniswap/v3-sdk'
import { Pool, Position, V4PositionManager } from '@uniswap/v4-sdk'
import { type Address, type Hex, zeroAddress } from 'viem'
import { addresses } from './addresses'
import type { PoolKey, Transaction } from './types'

/** A pool as the SDK needs it: key, decimals, and the current state from `getPoolState`. */
export type PoolSnapshot = {
	poolKey: PoolKey
	decimals0: number
	decimals1: number
	sqrtPriceX96: bigint
	liquidity: bigint
	tick: number
}

const toCurrency = (chainId: number, address: Address, decimals: number): Currency =>
	address === zeroAddress ? Ether.onChain(chainId) : new Token(chainId, address, decimals)

const toPool = (chainId: number, s: PoolSnapshot): Pool =>
	new Pool(
		toCurrency(chainId, s.poolKey.currency0, s.decimals0),
		toCurrency(chainId, s.poolKey.currency1, s.decimals1),
		s.poolKey.fee,
		s.poolKey.tickSpacing,
		s.poolKey.hooks,
		s.sqrtPriceX96.toString(),
		s.liquidity.toString(),
		s.tick,
	)

const useNativeFor = (chainId: number, poolKey: PoolKey) =>
	poolKey.currency0 === zeroAddress ? Ether.onChain(chainId) : undefined

const slippage = (bps: number) => new Percent(bps, 10_000)

const toTransaction = (
	to: Address,
	{ calldata, value }: { calldata: string; value: string },
): Transaction => ({
	to,
	data: calldata as Hex,
	value: BigInt(value),
})

/** sqrtPriceX96 for a pool where `amount0` of currency0 is worth `amount1` of currency1 (raw units). */
export function sqrtPriceX96FromAmounts({
	amount0,
	amount1,
}: {
	amount0: bigint
	amount1: bigint
}): bigint {
	return BigInt(encodeSqrtRatioX96(amount1.toString(), amount0.toString()).toString())
}

/** `initializePool` on the PositionManager for a pool that does not exist yet. */
export function encodeInitializePool({
	chainId,
	poolKey,
	sqrtPriceX96,
}: {
	chainId: number
	poolKey: PoolKey
	sqrtPriceX96: bigint
}): Transaction {
	const { calldata, value } = V4PositionManager.createCallParameters(
		poolKey,
		sqrtPriceX96.toString(),
	)
	return toTransaction(addresses(chainId).positionManager, { calldata, value })
}

type RangeInput = {
	chainId: number
	pool: PoolSnapshot
	tickLower: number
	tickUpper: number
	slippageBps: number
	deadline: bigint
	hookData?: Hex
}

export type MintPositionInput = RangeInput & {
	/** Desired deposit in raw units; the SDK fits the largest position both amounts allow. */
	amount0: bigint
	amount1: bigint
	recipient: Address
}

/** `MINT_POSITION` through the official position manager. Native currency0 is paid through `value`. */
export function encodeMintPosition({
	chainId,
	pool,
	tickLower,
	tickUpper,
	amount0,
	amount1,
	recipient,
	slippageBps,
	deadline,
	hookData,
}: MintPositionInput): Transaction & { liquidity: bigint } {
	const position = Position.fromAmounts({
		pool: toPool(chainId, pool),
		tickLower,
		tickUpper,
		amount0: amount0.toString(),
		amount1: amount1.toString(),
		useFullPrecision: true,
	})
	const params = V4PositionManager.addCallParameters(position, {
		recipient,
		slippageTolerance: slippage(slippageBps),
		deadline: deadline.toString(),
		useNative: useNativeFor(chainId, pool.poolKey),
		hookData,
	})
	return {
		...toTransaction(addresses(chainId).positionManager, params),
		liquidity: BigInt(position.liquidity.toString()),
	}
}

export type IncreaseLiquidityInput = RangeInput & {
	tokenId: bigint
	amount0: bigint
	amount1: bigint
}

/** `INCREASE_LIQUIDITY` on an existing position. */
export function encodeIncreaseLiquidity({
	chainId,
	pool,
	tokenId,
	tickLower,
	tickUpper,
	amount0,
	amount1,
	slippageBps,
	deadline,
	hookData,
}: IncreaseLiquidityInput): Transaction & { liquidity: bigint } {
	const position = Position.fromAmounts({
		pool: toPool(chainId, pool),
		tickLower,
		tickUpper,
		amount0: amount0.toString(),
		amount1: amount1.toString(),
		useFullPrecision: true,
	})
	const params = V4PositionManager.addCallParameters(position, {
		tokenId: tokenId.toString(),
		slippageTolerance: slippage(slippageBps),
		deadline: deadline.toString(),
		useNative: useNativeFor(chainId, pool.poolKey),
		hookData,
	})
	return {
		...toTransaction(addresses(chainId).positionManager, params),
		liquidity: BigInt(position.liquidity.toString()),
	}
}

export type DecreaseLiquidityInput = RangeInput & {
	tokenId: bigint
	/** The position's current liquidity, from your indexer or the PositionManager. */
	liquidity: bigint
	/** Share to remove in basis points; 10 000 removes everything. */
	percentageBps?: number
	/** Burn the NFT when removing everything. */
	burnToken?: boolean
}

/** `DECREASE_LIQUIDITY` (and optionally `BURN_POSITION`) on an existing position. */
export function encodeDecreaseLiquidity({
	chainId,
	pool,
	tokenId,
	tickLower,
	tickUpper,
	liquidity,
	percentageBps = 10_000,
	burnToken = false,
	slippageBps,
	deadline,
	hookData,
}: DecreaseLiquidityInput): Transaction {
	const position = new Position({
		pool: toPool(chainId, pool),
		liquidity: liquidity.toString(),
		tickLower,
		tickUpper,
	})
	const params = V4PositionManager.removeCallParameters(position, {
		tokenId: tokenId.toString(),
		liquidityPercentage: slippage(percentageBps),
		slippageTolerance: slippage(slippageBps),
		deadline: deadline.toString(),
		burnToken,
		hookData,
	})
	return toTransaction(addresses(chainId).positionManager, params)
}

export type CollectFeesInput = RangeInput & {
	tokenId: bigint
	liquidity: bigint
	recipient: Address
}

/** Collects accrued fees by decreasing zero liquidity and taking the pair. */
export function encodeCollectFees({
	chainId,
	pool,
	tokenId,
	tickLower,
	tickUpper,
	liquidity,
	recipient,
	slippageBps,
	deadline,
	hookData,
}: CollectFeesInput): Transaction {
	const position = new Position({
		pool: toPool(chainId, pool),
		liquidity: liquidity.toString(),
		tickLower,
		tickUpper,
	})
	const params = V4PositionManager.collectCallParameters(position, {
		tokenId: tokenId.toString(),
		recipient,
		slippageTolerance: slippage(slippageBps),
		deadline: deadline.toString(),
		hookData,
	})
	return toTransaction(addresses(chainId).positionManager, params)
}
