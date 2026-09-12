import { describe, expect, it } from 'bun:test'
import type { Address } from 'viem'

import {
	aggregationSpender,
	approveTransaction,
	OneInchError,
	spotPrices,
	swapQuote,
	swapTransaction,
	tokenBalances,
} from './api'

const WETH = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' as Address
const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' as Address
const TAKER = '0xF977814e90dA44bFA03b6295A0616a897441aceC' as Address

/** Records the path it was asked for and answers with what the live API answered on 11 September. */
const stub = (body: unknown, status = 200) => {
	const asked: string[] = []
	const f = async (path: string) => {
		asked.push(path)
		return new Response(JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json' },
		})
	}
	return { f, asked }
}

describe('the aggregation route', () => {
	it('asks for a quote and returns base units', async () => {
		// The real answer for 0.1 WETH → USDC on Arbitrum One.
		const { f, asked } = stub({ dstAmount: '246061367' })
		const out = await swapQuote(f, {
			chainId: 42161,
			src: WETH,
			dst: USDC,
			amount: 10n ** 17n,
		})
		expect(out).toBe(246061367n)
		expect(asked[0]).toBe(
			`/swap/v6.1/42161/quote?src=${WETH}&dst=${USDC}&amount=100000000000000000`,
		)
	})

	it('asks the API for the spender rather than carrying one', async () => {
		const { f } = stub({ address: '0x111111125421ca6dc452d289314280a0f8842a65' })
		expect(await aggregationSpender(f, 42161)).toBe('0x111111125421ca6dc452d289314280a0f8842a65')
	})

	it('turns basis points into the percent the API wants', async () => {
		const { f, asked } = stub({
			dstAmount: '24598619',
			tx: { to: TAKER, data: '0x07ed2379', value: '10000000000000000', gas: 308131 },
		})
		const tx = await swapTransaction(f, {
			chainId: 42161,
			src: WETH,
			dst: USDC,
			amount: 10n ** 16n,
			from: TAKER,
			slippageBps: 50,
		})
		expect(asked[0]).toContain('slippage=0.5')
		expect(tx.amountOut).toBe(24598619n)
		// `gas` comes back as a number and `value` as a string; both have to be bigints by the time
		// a wallet sees them, and a number that large is where a silent precision loss would live.
		expect(tx.gas).toBe(308131n)
		expect(tx.value).toBe(10n ** 16n)
	})

	it('sends receiver only when asked, so the output lands where the caller says', async () => {
		const { f, asked } = stub({
			dstAmount: '1009074',
			tx: { to: TAKER, data: '0x07ed2379', value: '400000000000000', gas: 162640 },
		})
		await swapTransaction(f, {
			chainId: 42161,
			src: WETH,
			dst: USDC,
			amount: 4n * 10n ** 14n,
			from: TAKER,
			slippageBps: 100,
			receiver: '0x8E0f7e6701c2e9b4F2591161B92c51b431591807',
		})
		expect(asked[0]).toContain('&receiver=0x8E0f7e6701c2e9b4F2591161B92c51b431591807')
		await swapTransaction(f, {
			chainId: 42161,
			src: WETH,
			dst: USDC,
			amount: 4n * 10n ** 14n,
			from: TAKER,
			slippageBps: 100,
		})
		expect(asked[1]).not.toContain('receiver')
	})

	it('names the refusal, because an allowance is fixable and liquidity is not', async () => {
		const { f } = stub(
			{
				error: 'Bad Request',
				description: 'Not enough allowance. Amount: 1. Allowance: 0.',
				statusCode: 400,
				code: 'NOT_ENOUGH_ALLOWANCE',
			},
			400,
		)
		const failure = await swapQuote(f, {
			chainId: 42161,
			src: WETH,
			dst: USDC,
			amount: 1n,
		}).catch((e) => e)
		expect(failure).toBeInstanceOf(OneInchError)
		expect((failure as OneInchError).code).toBe('NOT_ENOUGH_ALLOWANCE')
		expect((failure as OneInchError).status).toBe(400)
	})

	it('still reports something when the refusal has no body at all', async () => {
		const f = async () => new Response('<html>gateway</html>', { status: 502 })
		const failure = await aggregationSpender(f, 42161).catch((e) => e)
		expect((failure as OneInchError).code).toBe('HTTP_502')
	})

	it('asks for an approval of exactly the amount, never unlimited', async () => {
		const { f, asked } = stub({ to: WETH, data: '0x095ea7b3', value: '0' })
		await approveTransaction(f, { chainId: 42161, token: WETH, amount: 5n })
		expect(asked[0]).toContain('amount=5')
	})
})

describe('market and wallet data', () => {
	it('passes spot prices through as the API words them', async () => {
		const { f } = stub({ [WETH.toLowerCase()]: '2469.61926272' })
		const prices = await spotPrices(f, { chainId: 42161, tokens: [WETH] })
		expect(prices[WETH.toLowerCase()]).toBe('2469.61926272')
	})

	it('asks nothing when there is nothing to ask about', async () => {
		const { f, asked } = stub({})
		expect(await spotPrices(f, { chainId: 42161, tokens: [] })).toEqual({})
		expect(asked).toHaveLength(0)
	})

	it('drops the zero balances, which are almost all of them', async () => {
		// The live shape: every token the chain knows about, most of them at zero.
		const { f } = stub({
			'0x32eb7902d4134bf98a28b963d26de779af92a212': '0',
			'0x539bde0d7dbd336b79148aa742883198bbf60342': '82467152000000000000000000',
			[USDC.toLowerCase()]: '0',
		})
		const held = await tokenBalances(f, { chainId: 42161, address: TAKER })
		expect(Object.keys(held)).toEqual(['0x539bde0d7dbd336b79148aa742883198bbf60342'])
		expect(held['0x539bde0d7dbd336b79148aa742883198bbf60342']).toBe(82467152000000000000000000n)
	})
})
