import { describe, expect, test } from 'bun:test'
import { Ether, Token } from '@uniswap/sdk-core'
import { Pool } from '@uniswap/v4-sdk'
import { zeroAddress } from 'viem'
import { stateViewAbi } from './abi/stateView'
import { addresses } from './addresses'
import {
	createPoolKey,
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
