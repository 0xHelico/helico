import { describe, expect, test } from 'bun:test'
import { type Address, maxUint160, maxUint256, zeroAddress } from 'viem'
import { erc20Abi } from './abi/erc20'
import { permit2Abi } from './abi/permit2'
import { quoterAbi } from './abi/quoter'
import { stateViewAbi } from './abi/stateView'
import { addresses } from './addresses'
import { NATIVE, planSwap } from './plan'
import { createPoolKey, FEE_TIERS, poolId } from './pool'
import { fakeClient } from './test/fakeClient'

const ARBITRUM = 42161
const chain = addresses(ARBITRUM)
const USDC: Address = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
const ACCOUNT: Address = '0x1111111111111111111111111111111111111111'
// The live ETH/USDC 0.05% pool on 2026-09-07.
const SQRT_PRICE = 3968776570340178074372103n
const TICK = -198_246
const LIQUIDITY = 518_643_248_849_481_658n
const ONE_TENTH_ETH = 10n ** 17n
const QUOTED_OUT = 248_974_050n

const livePoolId = poolId(
	createPoolKey({ currencyA: zeroAddress, currencyB: USDC, fee: 500, tickSpacing: 10 }),
)

const stateView = {
	address: chain.stateView,
	abi: stateViewAbi,
	results: {
		getSlot0: (id: unknown) => (id === livePoolId ? [SQRT_PRICE, TICK, 0, 500] : [0n, 0, 0, 0]),
		getLiquidity: (id: unknown) => (id === livePoolId ? LIQUIDITY : 0n),
	},
}
const quoter = {
	address: chain.quoter,
	abi: quoterAbi,
	results: { quoteExactInputSingle: [QUOTED_OUT, 120_000n] },
}
const erc20 = (allowance: bigint) => ({
	address: USDC,
	abi: erc20Abi,
	results: { allowance },
})
const permit2 = (amount: bigint, expiration: number) => ({
	address: chain.permit2,
	abi: permit2Abi,
	results: { allowance: [amount, expiration, 0] },
})
const FAR_FUTURE = Math.floor(Date.now() / 1000) + 30 * 24 * 3600

const kinds = (steps: { kind: string }[]) => steps.map((s) => s.kind)

describe('planSwap, native input', () => {
	const client = () => fakeClient(ARBITRUM, [stateView, quoter]).client

	test('is one transaction, because native input has nothing to approve', async () => {
		const plan = await planSwap(client(), {
			account: ACCOUNT,
			tokenIn: NATIVE,
			tokenOut: USDC,
			amountIn: ONE_TENTH_ETH,
		})
		expect(kinds(plan.steps)).toEqual(['swap'])
	})

	test('pays through value, and goes to the Universal Router', async () => {
		const plan = await planSwap(client(), {
			account: ACCOUNT,
			tokenIn: NATIVE,
			tokenOut: USDC,
			amountIn: ONE_TENTH_ETH,
		})
		const swap = plan.steps[0]?.transaction
		expect(swap?.value).toBe(ONE_TENTH_ETH)
		expect(swap?.to).toBe(chain.universalRouter)
	})

	test('resolves the pool, the direction and the quote', async () => {
		const plan = await planSwap(client(), {
			account: ACCOUNT,
			tokenIn: NATIVE,
			tokenOut: USDC,
			amountIn: ONE_TENTH_ETH,
		})
		expect(plan.pool.key.fee).toBe(500)
		expect(plan.zeroForOne).toBe(true)
		expect(plan.amountOut).toBe(QUOTED_OUT)
	})

	test('the floor is the quote less the slippage, and the default is 50 bps', async () => {
		const plan = await planSwap(client(), {
			account: ACCOUNT,
			tokenIn: NATIVE,
			tokenOut: USDC,
			amountIn: ONE_TENTH_ETH,
		})
		expect(plan.slippageBps).toBe(50)
		expect(plan.minAmountOut).toBe(QUOTED_OUT - (QUOTED_OUT * 50n) / 10_000n)

		const tight = await planSwap(client(), {
			account: ACCOUNT,
			tokenIn: NATIVE,
			tokenOut: USDC,
			amountIn: ONE_TENTH_ETH,
			slippageBps: 10,
		})
		expect(tight.minAmountOut).toBeGreaterThan(plan.minAmountOut)
	})
})

describe('planSwap, ERC-20 input', () => {
	const withAllowances = (token: bigint, permit: bigint, expiration = FAR_FUTURE) =>
		fakeClient(ARBITRUM, [stateView, quoter, erc20(token), permit2(permit, expiration)]).client

	test('an untouched token needs both approvals, in the order they must be sent', async () => {
		const plan = await planSwap(withAllowances(0n, 0n), {
			account: ACCOUNT,
			tokenIn: USDC,
			tokenOut: NATIVE,
			amountIn: 100_000_000n,
		})
		expect(kinds(plan.steps)).toEqual(['approve-token', 'approve-permit2', 'swap'])
		expect(plan.steps[0]?.transaction.to).toBe(USDC)
		expect(plan.steps[1]?.transaction.to).toBe(chain.permit2)
	})

	// The one everyone gets wrong: the token is approved, so it looks done, but v4 spends
	// through Permit2 and Permit2's own allowance to the router has lapsed.
	test('an expired Permit2 allowance still needs its approval', async () => {
		const expired = Math.floor(Date.now() / 1000) - 1
		const plan = await planSwap(withAllowances(maxUint256, maxUint160, expired), {
			account: ACCOUNT,
			tokenIn: USDC,
			tokenOut: NATIVE,
			amountIn: 100_000_000n,
		})
		expect(kinds(plan.steps)).toEqual(['approve-permit2', 'swap'])
	})

	test('both allowances in place is a single transaction', async () => {
		const plan = await planSwap(withAllowances(maxUint256, maxUint160), {
			account: ACCOUNT,
			tokenIn: USDC,
			tokenOut: NATIVE,
			amountIn: 100_000_000n,
		})
		expect(kinds(plan.steps)).toEqual(['swap'])
		expect(plan.steps[0]?.transaction.value).toBe(0n)
	})

	test('an allowance that covers less than the amount is not enough', async () => {
		const plan = await planSwap(withAllowances(99_999_999n, maxUint160), {
			account: ACCOUNT,
			tokenIn: USDC,
			tokenOut: NATIVE,
			amountIn: 100_000_000n,
		})
		expect(kinds(plan.steps)).toEqual(['approve-token', 'swap'])
	})

	test('the direction flips when the input is currency1', async () => {
		const plan = await planSwap(withAllowances(maxUint256, maxUint160), {
			account: ACCOUNT,
			tokenIn: USDC,
			tokenOut: NATIVE,
			amountIn: 100_000_000n,
		})
		expect(plan.zeroForOne).toBe(false)
	})
})

describe('planSwap refuses rather than guesses', () => {
	test('a pair with no pool', async () => {
		const empty = {
			...stateView,
			results: { getSlot0: () => [0n, 0, 0, 0], getLiquidity: () => 0n },
		}
		expect(
			planSwap(fakeClient(ARBITRUM, [empty, quoter]).client, {
				account: ACCOUNT,
				tokenIn: NATIVE,
				tokenOut: USDC,
				amountIn: ONE_TENTH_ETH,
			}),
		).rejects.toThrow(/no hook-less pool/i)
	})

	test('an amount of zero', async () => {
		expect(
			planSwap(fakeClient(ARBITRUM, [stateView, quoter]).client, {
				account: ACCOUNT,
				tokenIn: NATIVE,
				tokenOut: USDC,
				amountIn: 0n,
			}),
		).rejects.toThrow(/above zero/i)
	})

	test('slippage of 100% or more, which would accept any fill', async () => {
		expect(
			planSwap(fakeClient(ARBITRUM, [stateView, quoter]).client, {
				account: ACCOUNT,
				tokenIn: NATIVE,
				tokenOut: USDC,
				amountIn: ONE_TENTH_ETH,
				slippageBps: 10_000,
			}),
		).rejects.toThrow(/under 100%/i)
	})

	test('a pool that quotes nothing for this size', async () => {
		const silent = { ...quoter, results: { quoteExactInputSingle: [0n, 0n] } }
		expect(
			planSwap(fakeClient(ARBITRUM, [stateView, silent]).client, {
				account: ACCOUNT,
				tokenIn: NATIVE,
				tokenOut: USDC,
				amountIn: ONE_TENTH_ETH,
			}),
		).rejects.toThrow(/cannot fill/i)
	})

	test('every fee tier is read before it gives up', async () => {
		const { client, calls } = fakeClient(ARBITRUM, [stateView, quoter])
		await planSwap(client, {
			account: ACCOUNT,
			tokenIn: NATIVE,
			tokenOut: USDC,
			amountIn: ONE_TENTH_ETH,
		})
		expect(calls.filter((c) => c.functionName === 'getSlot0')).toHaveLength(FEE_TIERS.length)
	})
})
