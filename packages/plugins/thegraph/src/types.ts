/**
 * A subgraph we can query, reached one of two ways.
 *
 * `id` is a subgraph **published** to The Graph Network: queried through the gateway, and the
 * gateway requires a key. `studioUrl` is one still in Subgraph Studio: free, rate-limited, and
 * unauthenticated, which is where a subgraph lives before anybody signals GRT on it.
 *
 * Exactly one of the two is set. Both being absent is a programming error and `endpoint()` says
 * so rather than building a URL with `undefined` in it.
 */
export type Subgraph = {
	/** Human name, for errors and logs. Never sent anywhere. */
	name: string
	chainId: number
	/** The id shown in the Graph Explorer, not the deployment id. */
	id?: string
	/** A Studio query URL. Development-grade: rate-limited, and not public. */
	studioUrl?: string
}

/**
 * The two v4 subgraphs published for the chains Helico targets.
 *
 * Ids come from the Graph Explorer. They are recorded here rather than passed in because a wrong
 * id fails at query time with a message about authorisation rather than about the id — see the
 * note in `gateway()`.
 */
export const UNISWAP_V4: Record<number, Subgraph> = {
	42161: {
		name: 'Uniswap v4 — Arbitrum One',
		id: 'D1VHPU6cXXSC8eaApWCjCnPcTZQFSYCpGoDAvt4ogDWh',
		chainId: 42161,
	},
	8453: {
		name: 'Uniswap v4 — Base',
		id: '2L6yxqUZ7dT6GWoTy9qxNBkf9kEk65me3XPMvbGsmJUZ',
		chainId: 8453,
	},
}

/**
 * What an hour of a pool looked like. A subset of the subgraph's `PoolHourData`: only the fields
 * a decision can act on, so a schema change elsewhere cannot silently widen what we depend on.
 */
export type PoolHour = {
	/** Unix seconds at the start of the hour. */
	periodStartUnix: number
	/** The pool's tick at that hour, or null when the subgraph recorded none. */
	tick: number | null
	feesUSD: number
	volumeUSD: number
	tvlUSD: number
}

/**
 * What the enclave cannot see for itself.
 *
 * `readChainState` reads one instant. Every question worth asking before moving a range is
 * historical — whether the price drifted or merely oscillated across the band, and whether the
 * pool earns enough to pay for the move — and none of it has an on-chain answer.
 */
export type PoolHistory = {
	/** How many hours were actually returned. Fewer than asked for is normal for a young pool. */
	hours: number
	/** Lowest and highest tick observed. Equal when only one hour had a tick. */
	tickMin: number
	tickMax: number
	/** Summed over the window. */
	feesUSD: number
	volumeUSD: number
	/** The most recent hour's total value locked, or 0 when the window was empty. */
	tvlUSD: number
}

/**
 * Our own subgraph over 1inch Aqua.
 *
 * Aqua keeps balances in a `private` mapping four levels deep and indexes no event parameter, so
 * "which mandates does this maker have, and what is left in each?" has no on-chain answer at all.
 * This is the answer. Published as *Helico Arbitrum One*, though what it indexes is Aqua's
 * contract rather than any of ours.
 *
 * It is a Studio deployment rather than a published one, so no key is needed and none is sent.
 * That is a real limit and not a detail: Studio endpoints are rate-limited and not meant to carry
 * production traffic. Publishing to the network is the fix, and it costs GRT.
 */
export const HELICO_AQUA: Record<number, Subgraph> = {
	42161: {
		name: 'Helico Arbitrum One — Aqua',
		chainId: 42161,
		studioUrl: 'https://api.studio.thegraph.com/query/1758877/helico-arbitrum-one/version/latest',
	},
}

/**
 * What is left of one token under one mandate.
 *
 * `amount` is a `bigint` rather than a `number` because these are token amounts: 1 ETH is 1e18,
 * and `Number` starts losing whole units above 2^53. The USD figures elsewhere in this package
 * are `number` because they are USD.
 */
export type MandateBalance = {
	token: string
	amount: bigint
	/**
	 * Aqua's own three-state sentinel: 0 never shipped, 1-254 active, 255 docked.
	 *
	 * This is the field that stops the balance lying. `dock` zeroes the ledger on chain and emits
	 * no per-token event, so an index that tracked only the running total would keep reporting a
	 * revoked allowance as spendable.
	 */
	tokensCount: number
	/** `tokensCount` read as the question a caller actually has. */
	spendable: boolean
}

/** One strategy a maker shipped, as Aqua files it. */
export type Mandate = {
	/** maker ‖ app ‖ strategyHash. Aqua keys balances by all three, so an id needs all three. */
	id: string
	/** Aqua's identifier: keccak256 of the bytes the maker shipped. */
	strategyHash: string
	/**
	 * The shipped bytes, undecoded.
	 *
	 * Every app on Aqua defines its own struct, so the subgraph does not decode these and neither
	 * does this package. A caller decodes them with the ABI it owns.
	 */
	strategy: string
	app: string
	/** True while at least one token under it is still spendable. */
	active: boolean
	shippedAt: number
	balances: MandateBalance[]
}
