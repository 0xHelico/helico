/**
 * 1inch's Business API — the aggregation route, the spot price, and what an address holds.
 *
 * **Why this sits beside the Aqua code rather than replacing it.** Everything else in this package
 * builds the position our own Aqua app prices. This file is the other half of the same partner: a
 * quote across every venue 1inch can reach, for the case where no maker's mandate can pay. The app
 * asks Aqua first because the mandate is the product; it asks here because a refusal is not an
 * answer a person can act on.
 *
 * **No key is read here, and that is the design.** Every function takes a `fetch`-shaped function
 * and nothing else, so the only place that knows the key is the server that adds the header. A
 * module that read `process.env` itself would be one import away from being bundled into a browser,
 * which is the one mistake that cannot be taken back.
 *
 * **Verified against the live API with a real key on 11 September**, on Arbitrum One, rather than
 * copied from a reference:
 *
 * ```
 * quote  0.1 WETH → USDC        {"dstAmount":"246061367"}   →  246.06 USDC
 * spender                       0x111111125421ca6dc452d289314280a0f8842a65
 * price  WETH in USD            2469.61926272
 * swap   with no allowance      NOT_ENOUGH_ALLOWANCE, and it names the spender
 * ```
 *
 * That last answer is why `swapTransaction` cannot be the first call a card makes: the aggregation
 * API refuses to build a transaction until the allowance exists. The approval goes first and the
 * question is asked again — the same two steps the Aqua path already takes.
 */
import type { Address, Hex } from 'viem'

/** The live API. Both `api.1inch.dev` and `api.1inch.com` answered identically; this is the one
 *  their own documentation names. */
export const ONEINCH_API = 'https://api.1inch.com'

/**
 * A path, fetched with whatever authorisation the caller arranged.
 *
 * `path` is relative and begins with a slash — `/swap/v6.1/42161/quote?…`. The caller prefixes the
 * base and adds the header; nothing here knows either.
 */
export type Fetcher = (path: string) => Promise<Response>

/**
 * How 1inch spells native ether, which is **not** how this repository does.
 *
 * The chat's intents use the zero address for ETH and the Aqua path wraps it to WETH before a fill,
 * because Aqua positions hold WETH and `pull` does `safeTransferFrom`. The aggregation router takes
 * ether directly, so the fallback has one step fewer than the Aqua path rather than one more — but
 * only if the address is translated, and a zero address sent here is a token that does not exist.
 */
export const ONEINCH_NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' as const

/** 1inch's spelling of whatever this app calls a token, native ether included. */
export function oneInchToken(token: Address): Address {
	return /^0x0{40}$/i.test(token) ? (ONEINCH_NATIVE as Address) : token
}

/**
 * What 1inch said went wrong, by its own name.
 *
 * The API answers a refusal with a `code` — `NOT_ENOUGH_ALLOWANCE`, `INSUFFICIENT_LIQUIDITY` — and
 * a sentence. Keeping both is what lets a card say which one happened instead of "request failed":
 * an allowance is something a person can fix in one transaction, and no liquidity is not.
 */
export class OneInchError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message)
		this.name = 'OneInchError'
	}
}

async function json<T>(f: Fetcher, path: string): Promise<T> {
	const response = await f(path)
	if (!response.ok) {
		// Their error body, when there is one. A gateway or a rate limiter answers with neither, so
		// the status is what is left to report and it is reported rather than swallowed.
		let code = `HTTP_${response.status}`
		let description = response.statusText || 'the request was refused'
		try {
			const body = (await response.json()) as { code?: string; description?: string }
			if (body.code) code = body.code
			if (body.description) description = body.description
		} catch {}
		throw new OneInchError(response.status, code, description)
	}
	return (await response.json()) as T
}

/** How much comes out, and nothing else. The cheapest question, and the only one a quote needs. */
export async function swapQuote(
	f: Fetcher,
	q: { chainId: number; src: Address; dst: Address; amount: bigint },
): Promise<bigint> {
	const { dstAmount } = await json<{ dstAmount: string }>(
		f,
		`/swap/v6.1/${q.chainId}/quote?src=${q.src}&dst=${q.dst}&amount=${q.amount}`,
	)
	return BigInt(dstAmount)
}

/** The address a taker approves. Asked rather than hardcoded: it is theirs to change, not ours. */
export async function aggregationSpender(f: Fetcher, chainId: number): Promise<Address> {
	const { address } = await json<{ address: Address }>(f, `/swap/v6.1/${chainId}/approve/spender`)
	return address
}

export type SwapTransaction = {
	/** What the swap is expected to return, at the moment it was built. */
	amountOut: bigint
	to: Address
	data: Hex
	value: bigint
	/** Their estimate. Passed on rather than used: a wallet estimates for itself. */
	gas: bigint
}

/**
 * The transaction itself, built by 1inch for one taker.
 *
 * Throws `OneInchError` with `NOT_ENOUGH_ALLOWANCE` when the allowance is missing, which is a
 * refusal worth showing rather than hiding: it names the exact thing the next transaction fixes.
 *
 * **`skipSimulation` is how a card can show both steps at once.** By default the API simulates the
 * swap before building it, so it refuses until the allowance already exists — and a plan that
 * cannot be built until its own first step has run cannot be shown to a person before they agree
 * to it. With the flag the transaction is built anyway. What makes that safe is the ordering rather
 * than optimism: the approval is step one of the same sequence, so the allowance is there by the
 * time the fill is sent, and the wallet estimates gas for itself either way. Measured, not assumed
 * — `disableEstimate=true` returned a transaction for an address with a zero allowance on
 * 11 September, and the same request without it returned `NOT_ENOUGH_ALLOWANCE`.
 */
export async function swapTransaction(
	f: Fetcher,
	q: {
		chainId: number
		src: Address
		dst: Address
		amount: bigint
		from: Address
		/** In basis points, as the rest of this repository counts slippage. The API wants percent. */
		slippageBps: number
		skipSimulation?: boolean
		/**
		 * Who receives the output, when it is not `from`. Measured on 12 September with a real key:
		 * the router's calldata then carries this address and the destination tokens land there —
		 * an address with no code yet included, which is what lets a swap fund an account that
		 * `open` creates in the same batch.
		 */
		receiver?: Address
	},
): Promise<SwapTransaction> {
	const slippage = q.slippageBps / 100
	const body = await json<{
		dstAmount: string
		tx: { to: Address; data: Hex; value: string; gas: number | string }
	}>(
		f,
		`/swap/v6.1/${q.chainId}/swap?src=${q.src}&dst=${q.dst}&amount=${q.amount}` +
			`&from=${q.from}&origin=${q.from}&slippage=${slippage}` +
			(q.skipSimulation ? '&disableEstimate=true' : '') +
			(q.receiver ? `&receiver=${q.receiver}` : ''),
	)
	return {
		amountOut: BigInt(body.dstAmount),
		to: body.tx.to,
		data: body.tx.data,
		value: BigInt(body.tx.value),
		gas: BigInt(body.tx.gas),
	}
}

/**
 * The approval 1inch wants for its own router, built by them.
 *
 * `amount` omitted asks for an unlimited allowance, which this repository does not do — the Aqua
 * path approves exactly what is shipped and this one approves exactly what is swapped.
 */
export async function approveTransaction(
	f: Fetcher,
	q: { chainId: number; token: Address; amount: bigint },
): Promise<{ to: Address; data: Hex; value: bigint }> {
	const body = await json<{ to: Address; data: Hex; value: string }>(
		f,
		`/swap/v6.1/${q.chainId}/approve/transaction?tokenAddress=${q.token}&amount=${q.amount}`,
	)
	return { to: body.to, data: body.data, value: BigInt(body.value) }
}

/**
 * Spot prices, in whole dollars with a decimal point, exactly as the API returns them.
 *
 * **Not used to size anything a person signs.** That figure is read from a Chainlink feed by the
 * wallet that will sign it, because a feed has a heartbeat and a staleness a caller can check.
 * This is for display, where being a few seconds old costs nothing.
 */
export async function spotPrices(
	f: Fetcher,
	q: { chainId: number; tokens: Address[] },
): Promise<Record<string, string>> {
	if (q.tokens.length === 0) return {}
	return await json<Record<string, string>>(
		f,
		`/price/v1.1/${q.chainId}/${q.tokens.join(',')}?currency=USD`,
	)
}

/**
 * Every token an address holds, keyed by token address, in base units.
 *
 * One call in place of one `balanceOf` per token we happened to have hardcoded — which is the
 * difference between a portfolio and a list of two things we already knew about.
 */
export async function tokenBalances(
	f: Fetcher,
	q: { chainId: number; address: Address },
): Promise<Record<string, bigint>> {
	const body = await json<Record<string, string>>(
		f,
		`/balance/v1.2/${q.chainId}/balances/${q.address}`,
	)
	const held: Record<string, bigint> = {}
	for (const [token, amount] of Object.entries(body)) {
		const value = BigInt(amount)
		// Every token the chain knows about comes back, most of them at zero. Dropping those here
		// is the difference between a portfolio and a thousand-row table of nothing.
		if (value > 0n) held[token.toLowerCase()] = value
	}
	return held
}
