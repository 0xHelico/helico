import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, type Hex, zeroAddress } from 'viem'
import { positionManagerAbi } from './abi/positionManager'
import { addresses } from './addresses'
import {
	encodeCollectFees,
	encodeDecreaseLiquidity,
	encodeIncreaseLiquidity,
	encodeInitializePool,
	encodeMintPosition,
	type PoolSnapshot,
	sqrtPriceX96FromAmounts,
} from './liquidity'
import { nearestUsableTick, sqrtPriceX96ToPrice } from './pool'

const BASE = 8453
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const RECIPIENT = '0x4200000000000000000000000000000000000006'
// Live Base ETH/USDC state from 2026-09-05.
const pool: PoolSnapshot = {
	poolKey: {
		currency0: zeroAddress,
		currency1: USDC,
		fee: 500,
		tickSpacing: 10,
		hooks: zeroAddress,
	},
	decimals0: 18,
	decimals1: 6,
	sqrtPriceX96: 3923091293860824873586817n,
	liquidity: 54379539174718576n,
	tick: -198275,
}
const range = {
	tickLower: nearestUsableTick(pool.tick - 1000, 10),
	tickUpper: nearestUsableTick(pool.tick + 1000, 10),
}
const common = { chainId: BASE, pool, ...range, slippageBps: 50, deadline: 1_700_000_000n }
const posm = addresses(BASE).positionManager

/** The SDK returns modifyLiquidities directly, or wrapped in multicall when there is more than one call. */
const decodeModify = (data: Hex) => {
	const outer = decodeFunctionData({ abi: positionManagerAbi, data })
	if (outer.functionName === 'modifyLiquidities') return outer.args
	if (outer.functionName === 'multicall') {
		const inner = decodeFunctionData({
			abi: positionManagerAbi,
			data: (outer.args[0] as Hex[])[0] as Hex,
		})
		if (inner.functionName === 'modifyLiquidities') return inner.args
	}
	throw new Error(`unexpected ${outer.functionName}`)
}

describe('mint / increase', () => {
	test('mint pays native currency0 through value and returns the fitted liquidity', () => {
		const tx = encodeMintPosition({
			...common,
			amount0: 10n ** 18n,
			amount1: 2500_000000n,
			recipient: RECIPIENT,
		})
		const [, deadline] = decodeModify(tx.data)
		expect(tx.to).toBe(posm)
		expect(tx.liquidity).toBeGreaterThan(0n)
		// value is the SDK's amount0Max: the input at the price bound the slippage allows, not a flat +0.5 %.
		expect(tx.value).toBeGreaterThan(10n ** 18n / 2n)
		expect(tx.value).toBeLessThan(10n ** 18n * 2n)
		expect(deadline).toBe(1_700_000_000n)
	})

	test('increase targets a token id and is deterministic', () => {
		const input = { ...common, tokenId: 42n, amount0: 10n ** 17n, amount1: 250_000000n }
		const tx = encodeIncreaseLiquidity(input)
		expect(tx.to).toBe(posm)
		expect(tx.liquidity).toBeGreaterThan(0n)
		expect(tx.value).toBeGreaterThan(0n)
		expect(decodeModify(tx.data)[1]).toBe(1_700_000_000n)
		expect(encodeIncreaseLiquidity(input)).toEqual(tx)
	})
})

describe('decrease / collect', () => {
	test('decrease sends no value and honours the deadline', () => {
		const tx = encodeDecreaseLiquidity({
			...common,
			tokenId: 42n,
			liquidity: 10n ** 12n,
			percentageBps: 5000,
		})
		expect(tx.to).toBe(posm)
		expect(tx.value).toBe(0n)
		expect(decodeModify(tx.data)[1]).toBe(1_700_000_000n)
	})

	test('collect sends no value', () => {
		const tx = encodeCollectFees({
			...common,
			tokenId: 42n,
			liquidity: 10n ** 12n,
			recipient: RECIPIENT,
		})
		expect(tx.to).toBe(posm)
		expect(tx.value).toBe(0n)
		expect(decodeModify(tx.data)[1]).toBe(1_700_000_000n)
	})
})

describe('initialize', () => {
	test('sqrtPriceX96FromAmounts round-trips through sqrtPriceX96ToPrice', () => {
		const sqrt = sqrtPriceX96FromAmounts({ amount0: 10n ** 18n, amount1: 2450_000000n })
		expect(Math.abs(sqrtPriceX96ToPrice(sqrt, 18, 6) - 2450)).toBeLessThan(0.01)
	})

	test('initializePool carries the pool key and price', () => {
		const sqrt = sqrtPriceX96FromAmounts({ amount0: 10n ** 18n, amount1: 2450_000000n })
		const tx = encodeInitializePool({ chainId: BASE, poolKey: pool.poolKey, sqrtPriceX96: sqrt })
		const { functionName, args } = decodeFunctionData({ abi: positionManagerAbi, data: tx.data })
		expect(tx.to).toBe(posm)
		expect(tx.value).toBe(0n)
		expect(functionName).toBe('initializePool')
		expect(args?.[0]).toEqual(pool.poolKey)
		expect(args?.[1]).toBe(sqrt)
	})
})
