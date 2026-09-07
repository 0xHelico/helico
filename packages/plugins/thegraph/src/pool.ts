import type { GraphAuth } from './client'
import { query } from './client'
import type { PoolHistory, PoolHour, Subgraph } from './types'

/**
 * The hours of a pool, most recent first.
 *
 * `poolHourDatas` is the v4 subgraph's own entity; `pool` is the v4 pool id, which is the same
 * bytes32 the vault stores in a mandate, lower-cased. Only the five fields a decision can act on
 * are asked for — a query that selects everything is a query that breaks when the schema grows.
 */
const HOURS = `
  query PoolHours($pool: String!, $first: Int!) {
    poolHourDatas(
      where: { pool: $pool }
      orderBy: periodStartUnix
      orderDirection: desc
      first: $first
    ) {
      periodStartUnix
      tick
      feesUSD
      volumeUSD
      tvlUSD
    }
  }
`

type Raw = {
	poolHourDatas: {
		periodStartUnix: number
		tick: string | null
		feesUSD: string
		volumeUSD: string
		tvlUSD: string
	}[]
}

/** The subgraph answers numbers as strings. One place converts them, and it tolerates nulls. */
export function toHours(raw: Raw): PoolHour[] {
	return raw.poolHourDatas.map((h) => ({
		periodStartUnix: Number(h.periodStartUnix),
		tick: h.tick === null || h.tick === undefined ? null : Number(h.tick),
		feesUSD: Number(h.feesUSD),
		volumeUSD: Number(h.volumeUSD),
		tvlUSD: Number(h.tvlUSD),
	}))
}

/**
 * Fold the hours into the few numbers a decision uses.
 *
 * Separated from the fetch so it can be tested against recorded hours without a key, and so the
 * enclave can fold what it already has rather than asking twice.
 *
 * An empty window is not an error: a pool with no trading has no hours, and a decision should read
 * that as "no evidence" rather than as a failure. `tickMin`/`tickMax` are `0` then, and `hours`
 * being `0` is what a caller must check before trusting them.
 */
export function summarise(hours: PoolHour[]): PoolHistory {
	const ticks = hours.map((h) => h.tick).filter((t): t is number => t !== null)
	return {
		hours: hours.length,
		tickMin: ticks.length ? Math.min(...ticks) : 0,
		tickMax: ticks.length ? Math.max(...ticks) : 0,
		feesUSD: hours.reduce((sum, h) => sum + h.feesUSD, 0),
		volumeUSD: hours.reduce((sum, h) => sum + h.volumeUSD, 0),
		tvlUSD: hours[0]?.tvlUSD ?? 0,
	}
}

/**
 * What the pool did over the last `hours` hours.
 *
 * The default window is a day, which is the shortest span that answers the question this exists
 * for: a range the price left an hour ago and came back to is oscillation, and one it left
 * yesterday and has not returned to is drift. An hour of data cannot tell those apart.
 */
export async function poolHistory(
	subgraph: Subgraph,
	auth: GraphAuth,
	poolId: string,
	hours = 24,
	fetchImpl: typeof fetch = fetch,
): Promise<PoolHistory> {
	const raw = await query<Raw>(
		subgraph,
		auth,
		HOURS,
		{ pool: poolId.toLowerCase(), first: hours },
		fetchImpl,
	)
	return summarise(toHours(raw))
}

/**
 * Whether the price left the range and stayed out, or crossed back and forth inside it.
 *
 * This is the judgement the enclave cannot make from `readChainState`, and the one that decides
 * whether a re-centre is worth its cost. Oscillation across a band is not drift, and re-centring
 * into it sells the position's own volatility.
 *
 * Returns `null` when there is not enough history to say — never a guess.
 */
export function drifted(
	history: PoolHistory,
	tickLower: number,
	tickUpper: number,
): boolean | null {
	if (history.hours < 2) {
		return null
	}
	const inside = history.tickMin >= tickLower && history.tickMax <= tickUpper
	return !inside
}
