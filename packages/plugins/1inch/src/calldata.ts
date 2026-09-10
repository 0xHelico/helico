import { Address } from '@1inch/sdk-core'
import { Order, SwapVMContract, TakerTraits } from '@1inch/swap-vm-sdk'
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
 * Fill somebody's position. **Send this**, do not `eth_call` it.
 *
 * The counterpart to `quoteCall`, and the half this package did not have: it could write a
 * position and price one, and could not take one.
 *
 * **A plain wallet can be the taker.** `SwapVM.swap()` is `external`, takes no callback, and reads
 * the taker off `msg.sender` — so no taker contract is needed, unlike `HelicoMandateSwap`, whose
 * `IHelicoMandateSwapCallback` is that app's requirement rather than Aqua's. One approval, one
 * transaction, the shape any DEX has.
 *
 * **The approval goes to the router, not to Aqua**, and getting that backwards costs a reverted
 * transaction with no useful message. `SwapVM.sol:243` calls `_transferFrom(taker, …, useAqua =
 * false)` with the flag hardcoded, so the taker's side is a plain `safeTransferFrom` by the router.
 * Only the maker's side (`:266`) goes through `AQUA.pull`.
 *
 * @param amountOutMin The floor. **Not optional in practice**: a maker's position is takeable by
 *        anyone at the price the maker wrote, so a fill sent without one is a fill that accepts
 *        whatever the position has become between the quote and the block it lands in. Positions
 *        here are small — the first is 5 USDC a side — and a single unprotected fill can empty one.
 * @param deadline Unix seconds, or `0n` for none. A quote is a price and a price goes stale.
 * @param receiver Where the output goes. Defaults to the taker.
 */
export function fillCall(
	chainId: number,
	order: Order,
	tokenIn: `0x${string}`,
	tokenOut: `0x${string}`,
	amountIn: bigint,
	amountOutMin: bigint,
	deadline = 0n,
	receiver?: `0x${string}`,
): Call {
	const c = SwapVMContract.buildSwapTx(new Address(swapVmAddress(chainId)), {
		order,
		tokenIn: new Address(tokenIn),
		tokenOut: new Address(tokenOut),
		amount: amountIn,
		takerTraits: TakerTraits.new({
			// `exactIn`: the taker names what they are spending. The alternative names the output
			// and lets the input float, which is the wrong way round for a wallet with a balance.
			exactIn: true,
			threshold: amountOutMin,
			// False, so a better price than the floor is accepted rather than refused. Strict would
			// mean a position that improved between quote and block reverts the fill.
			strictThreshold: false,
			deadline,
			...(receiver ? { customReceiver: new Address(receiver) } : {}),
		}),
	})
	return { to: String(c.to).toLowerCase() as `0x${string}`, data: String(c.data) as `0x${string}` }
}

/**
 * What the taker must approve before `fillCall` can succeed, and to whom.
 *
 * Its own function because the address is the one thing about this flow that is counter-intuitive:
 * everything else in this package talks to Aqua, and this one approval does not.
 */
export function fillApproval(chainId: number, tokenIn: `0x${string}`, amount: bigint): Call {
	return {
		to: tokenIn,
		data: encodeFunctionData({
			abi: parseAbi(['function approve(address spender, uint256 value) returns (bool)']),
			args: [swapVmAddress(chainId), amount],
			functionName: 'approve',
		}),
	}
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

/** A strategy as an index hands it over: the bytes, and the hash Aqua filed them under. */
export type ShippedStrategy = { strategyHash: string; strategy: string }

/** One strategy that decoded **and** proved to be the order it claims to be. */
export type OpenOrder = { order: Order; strategyHash: `0x${string}` }

/**
 * Turn shipped bytes into orders, discarding the ones that are not what they say.
 *
 * **The hash comparison is the gate, not a formality.** Aqua accepts arbitrary bytes and never
 * interprets them, so `Order.decode` succeeding says only that the bytes have the right shape. It
 * does not say they are the order Aqua filed — the position lives under `keccak256` of the raw
 * bytes, and a strategy that decodes to something else prices one thing while the ledger answers
 * for another.
 *
 * Measured rather than assumed: of eleven live strategies on Arbitrum One that decoded cleanly,
 * **six had a hash that did not match**. Without this gate a taker is offered six orders that do
 * not exist, and finds out by paying gas.
 *
 * Anything that throws on decode is dropped rather than reported: most strategies on Aqua belong
 * to other apps with other structs, and that is ordinary rather than an error.
 */
export function openOrders(shipped: ShippedStrategy[]): OpenOrder[] {
	const out: OpenOrder[] = []
	for (const s of shipped) {
		let order: Order
		try {
			// The SDK's own `HexString` is narrower than viem's `0x${string}`, and the two do not
			// assign to each other. Cast at the boundary rather than widening the whole package.
			order = Order.decode(s.strategy as unknown as Parameters<typeof Order.decode>[0])
		} catch {
			continue
		}
		if (orderHashHex(order).toLowerCase() !== s.strategyHash.toLowerCase()) continue
		out.push({ order, strategyHash: s.strategyHash.toLowerCase() as `0x${string}` })
	}
	return out
}

/**
 * `Order.hash()` as a `0x` string.
 *
 * The SDK returns a byte array here rather than hex, which compares equal to nothing and throws no
 * error when compared to a string — `'0x…' === Uint8Array` is simply `false`, so a gate written the
 * obvious way rejects every order and looks like an empty market.
 */
export function orderHashHex(order: Order): `0x${string}` {
	const h = order.hash() as unknown
	if (typeof h === 'string') return h as `0x${string}`
	if (h instanceof Uint8Array)
		return `0x${Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('')}`
	if (typeof h === 'bigint') return `0x${h.toString(16).padStart(64, '0')}`
	return String(h) as `0x${string}`
}
