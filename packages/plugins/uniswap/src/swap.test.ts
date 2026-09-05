import { describe, expect, test } from 'bun:test'
import { V4BaseActionsParser } from '@uniswap/v4-sdk'
import { decodeAbiParameters, decodeFunctionData, zeroAddress } from 'viem'
import { universalRouterAbi } from './abi/universalRouter'
import { addresses } from './addresses'
import {
	buildPath,
	deadlineFromNow,
	encodeSwapExactIn,
	encodeSwapExactInSingle,
	encodeSwapExactOut,
	encodeSwapExactOutSingle,
	MSG_SENDER,
	maximumAfterSlippage,
	minimumAfterSlippage,
} from './swap'
import type { PoolKey, Transaction } from './types'

const BASE = 8453
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const WETH = '0x4200000000000000000000000000000000000006'
const ethUsdc: PoolKey = {
	currency0: zeroAddress,
	currency1: USDC,
	fee: 500,
	tickSpacing: 10,
	hooks: zeroAddress,
}
const pool = { fee: 500, tickSpacing: 10 }
const deadline = 1_700_000_000n

/** Decodes execute() and the single V4_SWAP input into named actions. */
const decode = (tx: Transaction) => {
	const { functionName, args } = decodeFunctionData({ abi: universalRouterAbi, data: tx.data })
	if (functionName !== 'execute' || !args) throw new Error('not execute')
	const [commands, inputs, txDeadline] = args
	const parsed = V4BaseActionsParser.parseCalldata(inputs[0] as string)
	const actions = parsed.actions.map((a) => ({
		name: a.actionName,
		params: Object.fromEntries(a.params.map((p) => [p.name, String(p.value).toLowerCase()])),
	}))
	const sweep =
		inputs.length > 1
			? decodeAbiParameters(
					[{ type: 'address' }, { type: 'address' }, { type: 'uint256' }],
					inputs[1] as `0x${string}`,
				)
			: undefined
	return { commands, inputCount: inputs.length, deadline: txDeadline, actions, sweep }
}

describe('helpers', () => {
	test('slippage in basis points', () => {
		expect(minimumAfterSlippage(1000n, 50)).toBe(995n)
		expect(maximumAfterSlippage(1000n, 50)).toBe(1005n)
		expect(minimumAfterSlippage(1n, 50)).toBe(1n)
	})

	test('deadlineFromNow is unix seconds', () => {
		expect(deadlineFromNow(600, 1_700_000_000_000)).toBe(1_700_000_600n)
	})

	test('buildPath orders hops the way the router reads them', () => {
		const built = buildPath({
			currencies: [zeroAddress, USDC, WETH],
			pools: [pool, { ...pool, fee: 3000, tickSpacing: 60 }],
		})
		expect(built.currencyIn).toBe(zeroAddress)
		expect(built.currencyOut).toBe(WETH)
		expect(built.exactInPath.map((h) => h.intermediateCurrency)).toEqual([USDC, WETH])
		expect(built.exactOutPath.map((h) => h.intermediateCurrency)).toEqual([zeroAddress, USDC])
		expect(built.exactInPath[1]).toEqual({
			intermediateCurrency: WETH,
			fee: 3000,
			tickSpacing: 60,
			hooks: zeroAddress,
			hookData: '0x',
		})
	})

	test('buildPath rejects mismatched lists', () => {
		expect(() => buildPath({ currencies: [zeroAddress, USDC], pools: [] })).toThrow('n - 1 pools')
	})
})

describe('single-hop swaps', () => {
	test('exact input with native ETH: settle the input, take the minimum, pay through value', () => {
		const tx = encodeSwapExactInSingle({
			chainId: BASE,
			poolKey: ethUsdc,
			zeroForOne: true,
			amountIn: 10n ** 15n,
			amountOutMinimum: 1n,
			deadline,
		})
		const d = decode(tx)
		expect(tx.to).toBe(addresses(BASE).universalRouter)
		expect(tx.value).toBe(10n ** 15n)
		expect(d.commands).toBe('0x10')
		expect(d.inputCount).toBe(1)
		expect(d.deadline).toBe(deadline)
		expect(d.actions.map((a) => a.name)).toEqual(['SWAP_EXACT_IN_SINGLE', 'SETTLE_ALL', 'TAKE_ALL'])
		expect(d.actions[1]?.params).toEqual({ currency: zeroAddress, maxAmount: String(10n ** 15n) })
		expect(d.actions[2]?.params).toEqual({ currency: USDC.toLowerCase(), minAmount: '1' })
	})

	test('exact input with an ERC-20: nothing through value', () => {
		const tx = encodeSwapExactInSingle({
			chainId: BASE,
			poolKey: ethUsdc,
			zeroForOne: false,
			amountIn: 1000n,
			amountOutMinimum: 1n,
			deadline,
		})
		expect(tx.value).toBe(0n)
		expect(decode(tx).actions[1]?.params.currency).toBe(USDC.toLowerCase())
	})

	test('exact output with native ETH: settle up to the maximum, take the exact output, sweep the rest', () => {
		const tx = encodeSwapExactOutSingle({
			chainId: BASE,
			poolKey: ethUsdc,
			zeroForOne: true,
			amountOut: 1_000_000_000n,
			amountInMaximum: 10n ** 18n,
			deadline,
		})
		const d = decode(tx)
		expect(tx.value).toBe(10n ** 18n)
		expect(d.actions.map((a) => a.name)).toEqual([
			'SWAP_EXACT_OUT_SINGLE',
			'SETTLE_ALL',
			'TAKE_ALL',
		])
		expect(d.commands).toBe('0x1004')
		expect(d.inputCount).toBe(2)
		expect(d.sweep).toEqual([zeroAddress, MSG_SENDER, 0n])
	})

	test('exact output with an ERC-20 input needs no sweep', () => {
		const tx = encodeSwapExactOutSingle({
			chainId: BASE,
			poolKey: ethUsdc,
			zeroForOne: false,
			amountOut: 1n,
			amountInMaximum: 1000n,
			deadline,
		})
		expect(tx.value).toBe(0n)
		expect(decode(tx).commands).toBe('0x10')
		expect(decode(tx).actions.map((a) => a.name)).toEqual([
			'SWAP_EXACT_OUT_SINGLE',
			'SETTLE_ALL',
			'TAKE_ALL',
		])
	})

	test('is deterministic', () => {
		const input = {
			chainId: BASE,
			poolKey: ethUsdc,
			zeroForOne: true,
			amountIn: 5n,
			amountOutMinimum: 1n,
			deadline,
		}
		expect(encodeSwapExactInSingle(input)).toEqual(encodeSwapExactInSingle(input))
	})
})

describe('multi-hop swaps', () => {
	const route = buildPath({ currencies: [zeroAddress, USDC, WETH], pools: [pool, pool] })

	test('exact input carries the path and settles the input currency', () => {
		const tx = encodeSwapExactIn({
			chainId: BASE,
			...route,
			path: route.exactInPath,
			amountIn: 10n ** 15n,
			amountOutMinimum: 1n,
			deadline,
		})
		const d = decode(tx)
		expect(tx.value).toBe(10n ** 15n)
		expect(d.commands).toBe('0x10')
		expect(d.actions.map((a) => a.name)).toEqual(['SWAP_EXACT_IN', 'SETTLE_ALL', 'TAKE_ALL'])
		expect(d.actions[1]?.params.currency).toBe(zeroAddress)
		expect(d.actions[2]?.params.currency).toBe(WETH.toLowerCase())
	})

	test('exact output carries the reversed path and sweeps native input at the router level', () => {
		const tx = encodeSwapExactOut({
			chainId: BASE,
			...route,
			path: route.exactOutPath,
			amountOut: 10n ** 14n,
			amountInMaximum: 10n ** 15n,
			deadline,
		})
		const d = decode(tx)
		expect(tx.value).toBe(10n ** 15n)
		expect(d.commands).toBe('0x1004')
		expect(d.actions.map((a) => a.name)).toEqual(['SWAP_EXACT_OUT', 'SETTLE_ALL', 'TAKE_ALL'])
		expect(d.sweep).toEqual([zeroAddress, MSG_SENDER, 0n])
	})
})
