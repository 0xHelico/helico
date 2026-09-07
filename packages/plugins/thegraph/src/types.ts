/** A published subgraph on The Graph Network, addressed by its subgraph id. */
export type Subgraph = {
	/** Human name, for errors and logs. Never sent anywhere. */
	name: string
	/** The id shown in the Graph Explorer, not the deployment id. */
	id: string
	chainId: number
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
