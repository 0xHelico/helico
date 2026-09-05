import { nearestUsableTick as sdkNearestUsableTick, TickMath } from '@uniswap/v3-sdk'
import { type Address, encodeAbiParameters, type Hex, keccak256, zeroAddress } from 'viem'
import { readContract } from 'viem/actions'
import { stateViewAbi } from './abi/stateView'
import { addresses } from './addresses'
import { type ChainClient, chainIdOf } from './client'
import type { PoolKey } from './types'

export const MIN_TICK = TickMath.MIN_TICK
export const MAX_TICK = TickMath.MAX_TICK

/** v4 orders currencies by address; native ETH (zero address) always sorts first. */
export function sortCurrencies(a: Address, b: Address): [Address, Address] {
	if (a.toLowerCase() === b.toLowerCase()) throw new Error('A pool needs two different currencies')
	return BigInt(a) < BigInt(b) ? [a, b] : [b, a]
}

export type CreatePoolKeyInput = {
	currencyA: Address
	currencyB: Address
	fee: number
	tickSpacing: number
	hooks?: Address
}

/** Builds a PoolKey with the currencies in the order the protocol expects. */
export function createPoolKey({
	currencyA,
	currencyB,
	fee,
	tickSpacing,
	hooks = zeroAddress,
}: CreatePoolKeyInput): PoolKey {
	const [currency0, currency1] = sortCurrencies(currencyA, currencyB)
	return { currency0, currency1, fee, tickSpacing, hooks }
}

/** keccak256(abi.encode(poolKey)), the same derivation as PoolIdLibrary.toId in v4-core. */
export function poolId(key: PoolKey): Hex {
	return keccak256(
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
}

export type PoolState = {
	poolId: Hex
	sqrtPriceX96: bigint
	tick: number
	protocolFee: number
	lpFee: number
	liquidity: bigint
}

/** Price and liquidity from StateView. */
export async function getPoolState(client: ChainClient, key: PoolKey): Promise<PoolState> {
	const { stateView } = addresses(await chainIdOf(client))
	const id = poolId(key)
	const [[sqrtPriceX96, tick, protocolFee, lpFee], liquidity] = await Promise.all([
		readContract(client, {
			address: stateView,
			abi: stateViewAbi,
			functionName: 'getSlot0',
			args: [id],
		}),
		readContract(client, {
			address: stateView,
			abi: stateViewAbi,
			functionName: 'getLiquidity',
			args: [id],
		}),
	])
	return { poolId: id, sqrtPriceX96, tick, protocolFee, lpFee, liquidity }
}

/** Rounds a tick to the pool's spacing, clamped to the protocol range. */
export function nearestUsableTick(tick: number, tickSpacing: number): number {
	return sdkNearestUsableTick(tick, tickSpacing)
}

const Q96 = 2 ** 96

/**
 * Price of one unit of currency0 in currency1, adjusted for decimals.
 * Floating point: meant for display and range planning, not for settlement math.
 */
export function sqrtPriceX96ToPrice(
	sqrtPriceX96: bigint,
	decimals0: number,
	decimals1: number,
): number {
	const ratio = Number(sqrtPriceX96) / Q96
	return ratio * ratio * 10 ** (decimals0 - decimals1)
}

/** Price at a tick, adjusted for decimals. */
export function tickToPrice(tick: number, decimals0: number, decimals1: number): number {
	return 1.0001 ** tick * 10 ** (decimals0 - decimals1)
}

/** The highest tick whose price is at or below the given price. */
export function priceToTick(price: number, decimals0: number, decimals1: number): number {
	return Math.floor(Math.log(price / 10 ** (decimals0 - decimals1)) / Math.log(1.0001))
}
