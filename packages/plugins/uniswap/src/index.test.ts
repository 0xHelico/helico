import { describe, expect, test } from 'bun:test'
import { Ether, Token } from '@uniswap/sdk-core'
import { Pool } from '@uniswap/v4-sdk'
import { decodeFunctionData, type PublicClient, parseAbi, zeroAddress } from 'viem'
import {
	addresses,
	encodeSwapExactInSingle,
	getPoolState,
	type PoolKey,
	poolId,
	quoteExactInputSingle,
} from './index'

const BASE = 8453
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const ethUsdc: PoolKey = {
	currency0: zeroAddress,
	currency1: USDC,
	fee: 500,
	tickSpacing: 10,
	hooks: zeroAddress,
}
const executeAbi = parseAbi([
	'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
])

describe('addresses', () => {
	test('Base matches the official v4 deployments page', () => {
		expect(addresses(BASE)).toEqual({
			poolManager: '0x498581ff718922c3f8e6a244956af099b2652b2b',
			quoter: '0x0d5e0f971ed27fbff6c2837bf31316121532048d',
			stateView: '0xa3c0c9b65bad0b08107aa264b0f3db444b867a71',
			universalRouter: '0x6ff5693b99212da76ad316178a184ab56d299b43',
		})
	})

	test('throws where v4 is not deployed', () => {
		expect(() => addresses(999999)).toThrow('not deployed')
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

describe('encodeSwapExactInSingle', () => {
	const base = {
		chainId: BASE,
		poolKey: ethUsdc,
		amountIn: 10n ** 15n,
		amountOutMinimum: 1n,
		deadline: 1_700_000_000n,
	}

	test('targets the Universal Router with one V4_SWAP command', () => {
		const tx = encodeSwapExactInSingle({ ...base, zeroForOne: true })
		const { functionName, args } = decodeFunctionData({ abi: executeAbi, data: tx.data })
		expect(tx.to).toBe(addresses(BASE).universalRouter)
		expect(functionName).toBe('execute')
		expect(args?.[0]).toBe('0x10')
		expect(args?.[1]).toHaveLength(1)
		expect(args?.[2]).toBe(base.deadline)
	})

	test('pays a native input through value and an ERC-20 input through Permit2', () => {
		expect(encodeSwapExactInSingle({ ...base, zeroForOne: true }).value).toBe(base.amountIn)
		expect(encodeSwapExactInSingle({ ...base, zeroForOne: false }).value).toBe(0n)
	})

	test('is deterministic', () => {
		const a = encodeSwapExactInSingle({ ...base, zeroForOne: true })
		const b = encodeSwapExactInSingle({ ...base, zeroForOne: true })
		expect(a).toEqual(b)
	})
})

describe('reads', () => {
	const calls: { functionName: string; address: string; args: unknown[] }[] = []
	const client = {
		chain: { id: BASE },
		readContract: async (c: { functionName: string; address: string; args: unknown[] }) => {
			calls.push(c)
			return c.functionName === 'getSlot0'
				? [3923091293860824873586817n, -198275, 512125, 500]
				: 54379539174718576n
		},
		simulateContract: async (c: { functionName: string; address: string; args: unknown[] }) => {
			calls.push(c)
			return { result: [2447954705n, 80480n] }
		},
	} as unknown as PublicClient

	test('getPoolState reads StateView for the pool id', async () => {
		calls.length = 0
		const state = await getPoolState(client, ethUsdc)
		expect(state).toEqual({
			poolId: poolId(ethUsdc),
			sqrtPriceX96: 3923091293860824873586817n,
			tick: -198275,
			protocolFee: 512125,
			lpFee: 500,
			liquidity: 54379539174718576n,
		})
		expect(calls.map((c) => c.functionName).sort()).toEqual(['getLiquidity', 'getSlot0'])
		expect(new Set(calls.map((c) => c.address))).toEqual(new Set([addresses(BASE).stateView]))
		expect(calls.every((c) => c.args[0] === poolId(ethUsdc))).toBe(true)
	})

	test('quoteExactInputSingle simulates the Quoter', async () => {
		calls.length = 0
		const quote = await quoteExactInputSingle(client, {
			poolKey: ethUsdc,
			zeroForOne: true,
			amountIn: 10n ** 18n,
		})
		expect(quote).toEqual({ amountOut: 2447954705n, gasEstimate: 80480n })
		expect(calls[0]?.address).toBe(addresses(BASE).quoter)
		expect(calls[0]?.args[0]).toEqual({
			poolKey: ethUsdc,
			zeroForOne: true,
			exactAmount: 10n ** 18n,
			hookData: '0x',
		})
	})
})
