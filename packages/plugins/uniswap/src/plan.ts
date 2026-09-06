import { type Address, zeroAddress } from 'viem'
import {
	approvalsNeeded,
	encodeApprovePermit2,
	encodeApproveTokenToPermit2,
	getAllowances,
} from './approval'
import { type ChainClient, chainIdOf } from './client'
import { bestPoolFor, type FoundPool } from './pool'
import { quoteExactInputSingle } from './quote'
import { deadlineFromNow, encodeSwapExactInSingle, minimumAfterSlippage } from './swap'
import type { Transaction } from './types'

/** v4 spends native currency as the zero address; there is no wrapping step. */
export const NATIVE: Address = zeroAddress

/**
 * One transaction and what it is for. The words shown to a person are the app's to choose —
 * this package does not know which language they read.
 */
export type SwapStep = {
	kind: 'approve-token' | 'approve-permit2' | 'swap'
	transaction: Transaction
}

export type SwapPlan = {
	pool: FoundPool
	zeroForOne: boolean
	amountIn: bigint
	/** What the Quoter says comes out at the price right now. */
	amountOut: bigint
	/** The floor the swap will not fill below. */
	minAmountOut: bigint
	slippageBps: number
	deadline: bigint
	/** In the order they must be sent. One entry for a native input with nothing to approve. */
	steps: SwapStep[]
}

export type PlanSwapInput = {
	/** Whose allowances are read. The router resolves the recipient to the caller. */
	account: Address
	tokenIn: Address
	tokenOut: Address
	amountIn: bigint
	/** Default 50 bps. Shown to the user, never hidden. */
	slippageBps?: number
	deadlineSeconds?: number
	tiers?: readonly { fee: number; tickSpacing: number }[]
}

/**
 * Everything between "swap this for that" and a wallet prompt: which pool, what comes out,
 * which approvals are still missing, and the calldata.
 *
 * It is one function because the steps are not independent. The quote decides the floor the
 * swap encodes, and the approvals depend on the input amount, so an app that called the four
 * pieces itself would be re-deriving the same relationships — and getting the second Permit2
 * approval wrong, which is the mistake everyone makes once.
 *
 * Nothing here signs or sends. The result is a list of transactions the caller may show,
 * refuse, or hand to a wallet.
 */
export async function planSwap(
	client: ChainClient,
	{
		account,
		tokenIn,
		tokenOut,
		amountIn,
		slippageBps = 50,
		deadlineSeconds = 1800,
		tiers,
	}: PlanSwapInput,
): Promise<SwapPlan> {
	if (amountIn <= 0n) throw new Error('A swap needs an amount above zero')
	if (slippageBps < 0 || slippageBps >= 10_000) throw new Error('Slippage must be under 100%')

	const chainId = await chainIdOf(client)
	const pool = await bestPoolFor(client, tokenIn, tokenOut, tiers)
	if (!pool) throw new Error('No hook-less pool with liquidity for this pair on this chain')

	const zeroForOne = pool.key.currency0.toLowerCase() === tokenIn.toLowerCase()
	const { amountOut } = await quoteExactInputSingle(client, {
		poolKey: pool.key,
		zeroForOne,
		amountIn,
	})
	// A pool can be initialised, hold liquidity, and still quote nothing for a size this large.
	if (amountOut === 0n) throw new Error('The pool cannot fill an amount this size')

	const minAmountOut = minimumAfterSlippage(amountOut, slippageBps)
	const deadline = deadlineFromNow(deadlineSeconds)
	const steps: SwapStep[] = []

	// Native input is paid through `value`; there is nothing to approve. An ERC-20 needs two
	// approvals, and the second one is the one people forget: v4 spends through Permit2, so
	// Permit2 needs its own allowance to the router on top of the token's allowance to Permit2.
	if (tokenIn.toLowerCase() !== NATIVE) {
		const allowances = await getAllowances(client, { token: tokenIn, owner: account })
		const needed = approvalsNeeded(allowances, { amount: amountIn })
		if (needed.token) {
			steps.push({
				kind: 'approve-token',
				transaction: encodeApproveTokenToPermit2({ chainId, token: tokenIn }),
			})
		}
		if (needed.permit2) {
			steps.push({
				kind: 'approve-permit2',
				transaction: encodeApprovePermit2({ chainId, token: tokenIn }),
			})
		}
	}

	steps.push({
		kind: 'swap',
		transaction: encodeSwapExactInSingle({
			chainId,
			poolKey: pool.key,
			zeroForOne,
			amountIn,
			amountOutMinimum: minAmountOut,
			deadline,
		}),
	})

	return { pool, zeroForOne, amountIn, amountOut, minAmountOut, slippageBps, deadline, steps }
}
