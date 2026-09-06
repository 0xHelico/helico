import { describe, expect, test } from 'bun:test'
import { Ether, Token } from '@uniswap/sdk-core'
import { Pool } from '@uniswap/v4-sdk'
import { zeroAddress } from 'viem'
import { stateViewAbi } from './abi/stateView'
import { addresses } from './addresses'
import {
	bestPoolFor,
	createPoolKey,
	FEE_TIERS,
	getPoolState,
	nearestUsableTick,
	poolId,
	priceToTick,
	sortCurrencies,
	sqrtPriceX96ToPrice,
	tickToPrice,
} from './pool'
import { fakeClient } from './test/fakeClient'
import type { PoolKey } from './types'

const BASE = 8453
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const ethUsdc: PoolKey = {
	currency0: zeroAddress,
	currency1: USDC,
	fee: 500,
	tickSpacing: 10,
	hooks: zeroAddress,
}
// Live Base values from 2026-09-05.
const SQRT_PRICE = 3923091293860824873586817n
const TICK = -198275

describe('sortCurrencies / createPoolKey', () => {
	test('native ETH sorts first and order does not depend on input order', () => {
		expect(sortCurrencies(USDC, zeroAddress)).toEqual([zeroAddress, USDC])
		expect(
			createPoolKey({ currencyA: USDC, currencyB: zeroAddress, fee: 500, tickSpacing: 10 }),
		).toEqual(ethUsdc)
	})

	test('rejects a pool of one currency', () => {
		expect(() => sortCurrencies(USDC, USDC.toLowerCase() as typeof USDC)).toThrow('two different')
	})
})

describe('poolId', () => {
	test('matches Pool.getPoolId from @uniswap/v4-sdk', () => {
		const expected = Pool.getPoolId(
			Ether.onChain(BASE),
			new Token(BASE, USDC, 6),
			500,
			10,
			zeroAddress,
		)
		expect(poolId(ethUsdc)).toBe(expected as `0x${string}`)
	})
})

describe('getPoolState', () => {
	test('reads slot0 and liquidity from StateView for the pool id', async () => {
		const { client, calls } = fakeClient(BASE, [
			{
				address: addresses(BASE).stateView,
				abi: stateViewAbi,
				results: { getSlot0: [SQRT_PRICE, TICK, 512125, 500], getLiquidity: 54379539174718576n },
			},
		])

		const state = await getPoolState(client, ethUsdc)

		expect(state).toEqual({
			poolId: poolId(ethUsdc),
			sqrtPriceX96: SQRT_PRICE,
			tick: TICK,
			protocolFee: 512125,
			lpFee: 500,
			liquidity: 54379539174718576n,
		})
		expect(calls.map((c) => c.functionName).sort()).toEqual(['getLiquidity', 'getSlot0'])
		expect(calls.every((c) => c.args[0] === poolId(ethUsdc))).toBe(true)
	})
})

describe('ticks and prices', () => {
	test('nearestUsableTick snaps to the spacing', () => {
		expect(nearestUsableTick(-198273, 10)).toBe(-198270)
		expect(nearestUsableTick(17, 10)).toBe(20)
		expect(Math.abs(nearestUsableTick(-198275, 10) % 10)).toBe(0)
	})

	test('sqrtPriceX96ToPrice and tickToPrice agree with the live ETH/USDC price', () => {
		const fromSqrt = sqrtPriceX96ToPrice(SQRT_PRICE, 18, 6)
		const fromTick = tickToPrice(TICK, 18, 6)
		expect(Math.abs(fromSqrt - 2452)).toBeLessThan(5)
		expect(Math.abs(fromTick - fromSqrt)).toBeLessThan(1)
	})

	test('priceToTick is the floor of the inverse of tickToPrice', () => {
		const price = 2452
		const tick = priceToTick(price, 18, 6)
		expect(tickToPrice(tick, 18, 6)).toBeLessThanOrEqual(price)
		expect(tickToPrice(tick + 1, 18, 6)).toBeGreaterThan(price)
	})
})

describe('bestPoolFor', () => {
	const stateViewOf = (liquidityByTier: Record<number, bigint>) => {
		const byId = new Map<string, bigint>()
		for (const { fee, tickSpacing } of FEE_TIERS) {
			const liquidity = liquidityByTier[fee]
			if (liquidity !== undefined) {
				byId.set(
					poolId(createPoolKey({ currencyA: zeroAddress, currencyB: USDC, fee, tickSpacing })),
					liquidity,
				)
			}
		}
		return {
			address: addresses(BASE).stateView,
			abi: stateViewAbi,
			results: {
				// An uninitialised key answers zeros rather than reverting, which is what StateView does.
				getSlot0: (id: unknown) =>
					byId.has(id as string) ? [SQRT_PRICE, TICK, 0, 500] : [0n, 0, 0, 0],
				getLiquidity: (id: unknown) => byId.get(id as string) ?? 0n,
			},
		}
	}

	test('picks the deepest initialised tier', async () => {
		const { client } = fakeClient(BASE, [stateViewOf({ 500: 100n, 3000: 900n, 10000: 5n })])
		const found = await bestPoolFor(client, zeroAddress, USDC)
		expect(found?.key.fee).toBe(3000)
		expect(found?.state.liquidity).toBe(900n)
	})

	test('reads every tier once, and only the tiers', async () => {
		const { client, calls } = fakeClient(BASE, [stateViewOf({ 500: 1n })])
		await bestPoolFor(client, zeroAddress, USDC)
		expect(calls.filter((c) => c.functionName === 'getSlot0')).toHaveLength(FEE_TIERS.length)
	})

	test('a pair with no pool is undefined, not an exception', async () => {
		const { client } = fakeClient(BASE, [stateViewOf({})])
		expect(await bestPoolFor(client, zeroAddress, USDC)).toBeUndefined()
	})

	test('an initialised pool that has been fully withdrawn is not a candidate', async () => {
		const { client } = fakeClient(BASE, [stateViewOf({ 500: 0n })])
		expect(await bestPoolFor(client, zeroAddress, USDC)).toBeUndefined()
	})

	test('a chain whose liquidity sits off the standard tiers is served by its own list', async () => {
		const odd = { fee: 87, tickSpacing: 1 }
		const key = createPoolKey({ currencyA: zeroAddress, currencyB: USDC, ...odd })
		const { client } = fakeClient(BASE, [
			{
				address: addresses(BASE).stateView,
				abi: stateViewAbi,
				results: {
					getSlot0: (id: unknown) =>
						id === poolId(key) ? [SQRT_PRICE, TICK, 0, 87] : [0n, 0, 0, 0],
					getLiquidity: (id: unknown) => (id === poolId(key) ? 42n : 0n),
				},
			},
		])
		expect((await bestPoolFor(client, zeroAddress, USDC, [odd]))?.key.fee).toBe(87)
	})
})
