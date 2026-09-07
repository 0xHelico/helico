import { describe, expect, test } from 'bun:test'
import { zeroAddress } from 'viem'
import { quoterAbi } from './abi/quoter'
import { addresses } from './addresses'
import {
	quoteExactInput,
	quoteExactInputSingle,
	quoteExactOutput,
	quoteExactOutputSingle,
} from './quote'
import { fakeClient } from './test/fakeClient'
import type { PathKey, PoolKey } from './types'

const BASE = 8453
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const ethUsdc: PoolKey = {
	currency0: zeroAddress,
	currency1: USDC,
	fee: 500,
	tickSpacing: 10,
	hooks: zeroAddress,
}
const hop: PathKey = {
	intermediateCurrency: USDC,
	fee: 500,
	tickSpacing: 10,
	hooks: zeroAddress,
	hookData: '0x',
}

/** The Quoter answers every function with the same pair so the mapping of outputs is what gets tested. */
const quoter = () =>
	fakeClient(BASE, [
		{
			address: addresses(BASE).quoter,
			abi: quoterAbi,
			results: {
				quoteExactInputSingle: [2447954705n, 80480n],
				quoteExactOutputSingle: [407905856564516898n, 80480n],
				quoteExactInput: [24497077n, 150000n],
				quoteExactOutput: [4081979168789944n, 150000n],
			},
		},
	])

describe('quotes', () => {
	test('quoteExactInputSingle encodes the params struct and names the output', async () => {
		const { client, calls } = quoter()
		const quote = await quoteExactInputSingle(client, {
			poolKey: ethUsdc,
			zeroForOne: true,
			amountIn: 10n ** 18n,
		})
		expect(quote).toEqual({ amountOut: 2447954705n, gasEstimate: 80480n })
		expect(calls[0]?.functionName).toBe('quoteExactInputSingle')
		expect(calls[0]?.args[0]).toEqual({
			poolKey: ethUsdc,
			zeroForOne: true,
			exactAmount: 10n ** 18n,
			hookData: '0x',
		})
	})

	test('quoteExactOutputSingle names the input', async () => {
		const { client, calls } = quoter()
		const quote = await quoteExactOutputSingle(client, {
			poolKey: ethUsdc,
			zeroForOne: true,
			amountOut: 1_000_000_000n,
		})
		expect(quote).toEqual({ amountIn: 407905856564516898n, gasEstimate: 80480n })
		expect(calls[0]?.functionName).toBe('quoteExactOutputSingle')
		expect(calls[0]?.args[0]).toEqual({
			poolKey: ethUsdc,
			zeroForOne: true,
			exactAmount: 1_000_000_000n,
			hookData: '0x',
		})
	})

	test('quoteExactInput passes the path starting at currencyIn', async () => {
		const { client, calls } = quoter()
		const quote = await quoteExactInput(client, {
			currencyIn: zeroAddress,
			path: [hop],
			amountIn: 10n ** 18n,
		})
		expect(quote.amountOut).toBe(24497077n)
		expect(calls[0]?.functionName).toBe('quoteExactInput')
		expect(calls[0]?.args[0]).toEqual({
			exactCurrency: zeroAddress,
			path: [hop],
			exactAmount: 10n ** 18n,
		})
	})

	test('quoteExactOutput passes the path ending at currencyOut', async () => {
		const { client, calls } = quoter()
		const path = [{ ...hop, intermediateCurrency: zeroAddress }]
		const quote = await quoteExactOutput(client, { currencyOut: USDC, path, amountOut: 1n })
		expect(quote.amountIn).toBe(4081979168789944n)
		expect(calls[0]?.functionName).toBe('quoteExactOutput')
		expect(calls[0]?.args[0]).toEqual({ exactCurrency: USDC, path, exactAmount: 1n })
	})

	test('refuses a chain without v4', async () => {
		const { client } = fakeClient(999999, [])
		await expect(
			quoteExactInputSingle(client, { poolKey: ethUsdc, zeroForOne: true, amountIn: 1n }),
		).rejects.toThrow('not known')
	})
})
