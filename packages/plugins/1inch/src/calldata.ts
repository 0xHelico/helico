import { Address } from '@1inch/sdk-core'
import { type Order, SwapVMContract, TakerTraits } from '@1inch/swap-vm-sdk'
import { encodeFunctionData, keccak256, parseAbi } from 'viem'

import { aquaAddress, swapVmAddress } from './addresses'

/** Only the four Aqua entry points this package uses. Aqua has six, and two are views. */
export const AQUA_ABI = parseAbi([
	'function ship(address app, bytes strategy, address[] tokens, uint256[] amounts) returns (bytes32)',
	'function dock(address app, bytes32 strategyHash, address[] tokens)',
	'function rawBalances(address maker, address app, bytes32 strategyHash, address token) view returns (uint248, uint8)',
])

export type Call = { to: `0x${string}`; data: `0x${string}` }

/**
 * Open the position.
 *
 * **This moves no tokens.** `ship` writes a ledger entry and nothing else — verified on a fork:
 * three ships from one wallet produced three `Shipped` events, six `Pushed`, and not one ERC20
 * `Transfer`, with the wallet's balances byte-identical afterwards.
 *
 * Which also means `amounts` is a claim, not a deposit. Aqua does not check the wallet here; the
 * check is `safeTransferFrom` inside `pull`, at execution. One wallet holding 10 WETH can commit
 * 10 WETH to as many strategies as it likes, and the first fill wins. That is the shape of the
 * thing — see `spendableAgainst` for the part that has to be watched.
 */
export function shipCall(
	chainId: number,
	strategy: `0x${string}`,
	tokens: `0x${string}`[],
	amounts: bigint[],
	// Which app the position is filed under. Defaults to 1inch's SwapVM router, which is what a
	// `concentrate` strategy prices on; pass `HelicoMandateSwap` to ship a mandate instead. It is
	// last and optional because the two callers that predate mandates mean the default.
	app: `0x${string}` = swapVmAddress(chainId),
): Call {
	if (tokens.length !== amounts.length)
		throw new Error('tokens and amounts must be the same length')
	return {
		to: aquaAddress(chainId),
		data: encodeFunctionData({
			abi: AQUA_ABI,
			functionName: 'ship',
			args: [app, strategy, tokens, amounts],
		}),
	}
}

/** Close it. Needs nobody's permission and nothing can block it, because nothing was deposited. */
export function dockCall(
	chainId: number,
	strategyHash: `0x${string}`,
	tokens: `0x${string}`[],
): Call {
	return {
		to: aquaAddress(chainId),
		data: encodeFunctionData({
			abi: AQUA_ABI,
			functionName: 'dock',
			args: [swapVmAddress(chainId), strategyHash, tokens],
		}),
	}
}

/** Aqua's own identifier for a shipped strategy: the hash of the bytes it was given. */
export function strategyHash(strategy: `0x${string}`): `0x${string}` {
	return keccak256(strategy)
}

/**
 * What the position would pay, straight from the deployed SwapVM. `eth_call` this.
 *
 * A quote is the only honest test that a strategy is live: it reads the Aqua ledger, so it fails
 * for a docked one, an unshipped one, and — the case that cost an afternoon — one shipped under
 * bytes that hash differently from the order.
 */
export function quoteCall(
	chainId: number,
	order: Order,
	tokenIn: `0x${string}`,
	tokenOut: `0x${string}`,
	amountIn: bigint,
): Call {
	const c = SwapVMContract.buildQuoteTx(new Address(swapVmAddress(chainId)), {
		order,
		tokenIn: new Address(tokenIn),
		tokenOut: new Address(tokenOut),
		amount: amountIn,
		takerTraits: TakerTraits.default(),
	})
	return { to: String(c.to).toLowerCase() as `0x${string}`, data: String(c.data) as `0x${string}` }
}

/**
 * How far a wallet has over-committed: what its live strategies together claim, against what it
 * actually holds.
 *
 * Over 100% is not an error and not leverage — the strategy that fills first gets the tokens and
 * the rest revert in `pull`. It is a number an agent has to watch, because once a fill lands the
 * remaining strategies quote prices the wallet can no longer honour, and every taker who tries
 * pays gas to find out.
 */
export function overCommitment(committed: bigint[], held: bigint): number {
	if (held === 0n) return committed.some((c) => c > 0n) ? Number.POSITIVE_INFINITY : 0
	const total = committed.reduce((a, b) => a + b, 0n)
	// Basis points first, so the ratio survives amounts far beyond a double.
	return Number((total * 10_000n) / held) / 100
}
