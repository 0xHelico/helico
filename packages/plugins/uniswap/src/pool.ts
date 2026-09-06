import { nearestUsableTick as sdkNearestUsableTick, TickMath } from '@uniswap/v3-sdk'
import {
	type Address,
	BaseError,
	ContractFunctionRevertedError,
	encodeAbiParameters,
	type Hex,
	keccak256,
	zeroAddress,
} from 'viem'
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

/**
 * The fee tiers and spacings the Uniswap interface creates pools at. v4 allows any pair of
 * values, so this is a convention rather than a rule — a chain whose liquidity sits somewhere
 * else is served by passing its own list to `bestPoolFor`.
 */
export const FEE_TIERS: readonly { fee: number; tickSpacing: number }[] = [
	{ fee: 100, tickSpacing: 1 },
	{ fee: 500, tickSpacing: 10 },
	{ fee: 3000, tickSpacing: 60 },
	{ fee: 10_000, tickSpacing: 200 },
]

export type FoundPool = { key: PoolKey; state: PoolState }

/**
 * The hook-less pool for a pair that holds the most liquidity, or `undefined` when none of the
 * tiers has been initialised.
 *
 * A trade needs a pool before it needs anything else, and v4 has no registry to ask: a pool is
 * whatever key someone initialised. `discover.ts` answers that by walking `Initialize` logs,
 * which is right for a survey and far too slow to run while a person waits. This reads the few
 * keys the interface actually creates, in one round of calls, and picks the deepest.
 *
 * Hook-less only, deliberately. A pool with a hook can charge a dynamic fee, refuse the swap,
 * or move the price, and none of that can be shown to someone honestly from a quote alone.
 */
export async function bestPoolFor(
	client: ChainClient,
	currencyA: Address,
	currencyB: Address,
	tiers: readonly { fee: number; tickSpacing: number }[] = FEE_TIERS,
): Promise<FoundPool | undefined> {
	const keys = tiers.map(({ fee, tickSpacing }) =>
		createPoolKey({ currencyA, currencyB, fee, tickSpacing }),
	)
	const found = await Promise.all(
		keys.map(async (key) => {
			// StateView answers zeros for a key nobody initialised, so the ordinary "no such pool"
			// case is not an error at all. A revert still means this tier is not a candidate. A
			// transport failure means we do not know, and saying "no pool" then is a lie that sends
			// someone looking for liquidity that is there — so it propagates.
			const state = await getPoolState(client, key).catch((error: unknown) => {
				if (
					error instanceof BaseError &&
					error.walk((e) => e instanceof ContractFunctionRevertedError)
				) {
					return undefined
				}
				throw error
			})
			return state && state.sqrtPriceX96 > 0n && state.liquidity > 0n ? { key, state } : undefined
		}),
	)
	return found
		.filter((f): f is FoundPool => f !== undefined)
		.reduce<FoundPool | undefined>(
			(best, f) => (best && best.state.liquidity >= f.state.liquidity ? best : f),
			undefined,
		)
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
