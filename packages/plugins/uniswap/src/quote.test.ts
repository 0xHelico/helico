import { describe, expect, test } from 'bun:test'
import { type PublicClient, zeroAddress } from 'viem'
import { addresses } from './addresses'
import {
	quoteExactInput,
	quoteExactInputSingle,
	quoteExactOutput,
	quoteExactOutputSingle,
} from './quote'
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

type Call = { address: string; functionName: string; args: unknown[] }

const fakeClient = (calls: Call[]) =>
	({
		chain: { id: BASE },
		simulateContract: async (c: Call) => {
			calls.push(c)
			return { result: [2447954705n, 80480n] }
		},
	}) as unknown as PublicClient

describe('quotes', () => {
	test('quoteExactInputSingle simulates the Quoter and names the output', async () => {
		const calls: Call[] = []
		const quote = await quoteExactInputSingle(fakeClient(calls), {
			poolKey: ethUsdc,
			zeroForOne: true,
			amountIn: 10n ** 18n,
		})
		expect(quote).toEqual({ amountOut: 2447954705n, gasEstimate: 80480n })
		expect(calls[0]?.address).toBe(addresses(BASE).quoter)
		expect(calls[0]?.functionName).toBe('quoteExactInputSingle')
		expect(calls[0]?.args[0]).toEqual({
			poolKey: ethUsdc,
			zeroForOne: true,
			exactAmount: 10n ** 18n,
			hookData: '0x',
		})
	})

	test('quoteExactOutputSingle names the input', async () => {
		const calls: Call[] = []
		const quote = await quoteExactOutputSingle(fakeClient(calls), {
			poolKey: ethUsdc,
			zeroForOne: true,
			amountOut: 1000_000000n,
		})
		expect(quote).toEqual({ amountIn: 2447954705n, gasEstimate: 80480n })
		expect(calls[0]?.functionName).toBe('quoteExactOutputSingle')
		expect(calls[0]?.args[0]).toEqual({
			poolKey: ethUsdc,
			zeroForOne: true,
			exactAmount: 1000_000000n,
			hookData: '0x',
		})
	})

	test('quoteExactInput passes the path starting at currencyIn', async () => {
		const calls: Call[] = []
		await quoteExactInput(fakeClient(calls), {
			currencyIn: zeroAddress,
			path: [hop],
			amountIn: 10n ** 18n,
		})
		expect(calls[0]?.functionName).toBe('quoteExactInput')
		expect(calls[0]?.args[0]).toEqual({
			exactCurrency: zeroAddress,
			path: [hop],
			exactAmount: 10n ** 18n,
		})
	})

	test('quoteExactOutput passes the path ending at currencyOut', async () => {
		const calls: Call[] = []
		const quote = await quoteExactOutput(fakeClient(calls), {
			currencyOut: USDC,
			path: [{ ...hop, intermediateCurrency: zeroAddress }],
			amountOut: 1n,
		})
		expect(quote.amountIn).toBe(2447954705n)
		expect(calls[0]?.functionName).toBe('quoteExactOutput')
		expect(calls[0]?.args[0]).toEqual({
			exactCurrency: USDC,
			path: [{ ...hop, intermediateCurrency: zeroAddress }],
			exactAmount: 1n,
		})
	})
})
