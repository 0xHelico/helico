import type { GraphAuth } from './client'
import { query } from './client'
import type { MakerMandates, Mandate, Subgraph } from './types'

/**
 * Every mandate a maker has, and what is left in each.
 *
 * This is the query the chain cannot serve. Aqua's `_balances` is `private` and four levels deep
 * — maker, app, strategyHash, token — so nothing enumerates it, `rawBalances` needs a hash you
 * already hold, and not one parameter of the four events is `indexed`, so logs cannot be filtered
 * by maker either. An agent that must know what it is allowed to spend before it acts has no
 * other way to find out.
 *
 * `strategy` comes back raw. Aqua never interprets those bytes and neither does the subgraph —
 * each app defines its own struct, so the caller decodes with the ABI it owns.
 */
const MANDATES = `
  query Mandates($maker: Bytes!, $first: Int!, $skip: Int!) {
    mandates(
      where: { maker: $maker }
      orderBy: shippedAtBlock
      orderDirection: desc
      first: $first
      skip: $skip
    ) {
      strategyHash
      strategy
      active
      movementCount
      shippedAt
      app { id }
      balances { token amount tokensCount totalPulled totalPushed }
    }
  }
`

type Raw = {
	mandates: {
		strategyHash: string
		strategy: string
		active: boolean
		movementCount: number
		shippedAt: string
		app: { id: string }
		balances: {
			token: string
			amount: string
			tokensCount: number
			totalPulled: string
			totalPushed: string
		}[]
	}[]
}

/**
 * The subgraph answers every number as a string, and token amounts do not fit in a double.
 *
 * `amount` and the two totals become `bigint`; `movementCount` and `tokensCount` are counts that
 * cannot overflow and stay numbers. Getting this wrong is silent: `Number('1000000000000000000')`
 * is a value, just not the right one.
 */
export function toMandates(raw: Raw): Mandate[] {
	return raw.mandates.map((m) => ({
		strategyHash: m.strategyHash,
		strategy: m.strategy,
		active: m.active,
		app: m.app.id,
		movementCount: m.movementCount,
		shippedAt: Number(m.shippedAt),
		balances: m.balances.map((b) => ({
			token: b.token,
			amount: BigInt(b.amount),
			// Aqua's own sentinel: 0 never shipped, 1–254 active, 255 docked. `dock` zeroes the
			// ledger and emits nothing per token, so an amount alone cannot say whether a token is
			// still spendable — only this can.
			spendable: b.tokensCount > 0 && b.tokensCount < 255,
			totalPulled: BigInt(b.totalPulled),
			totalPushed: BigInt(b.totalPushed),
		})),
	}))
}

/** What a maker may still spend, per token, across every mandate that is not docked. */
export function spendable(mandates: Mandate[]): Map<string, bigint> {
	const total = new Map<string, bigint>()
	for (const m of mandates) {
		if (!m.active) continue
		for (const b of m.balances) {
			if (!b.spendable) continue
			total.set(b.token, (total.get(b.token) ?? 0n) + b.amount)
		}
	}
	return total
}

/** The Graph caps a page at 1000, so this is the largest useful request. */
const PAGE = 1000

/**
 * Ask the subgraph what a maker is allowed to do.
 *
 * Two ways to get a wrong answer here, and both look like a right one.
 *
 * `maker` is lower-cased because the subgraph stores addresses as lower-case `Bytes`. A
 * checksummed address matches nothing and returns an **empty list rather than an error**, so a
 * maker with fifty mandates reads as a maker with none.
 *
 * And every page is followed until one comes back short. A caller that silently receives a
 * prefix decides what an agent may spend against a portfolio it cannot see all of, which is
 * worse than failing — the diagnosis is @ghozzza's, in #161. This is also why the query is
 * top-level `mandates(where:)` rather than `maker(id:) { mandates }`: a nested list caps at 100
 * with no `pageInfo` and no cursor, so nothing in that response distinguishes "100 mandates"
 * from "100 of 5000".
 */
export async function makerMandates(
	subgraph: Subgraph,
	maker: string,
	auth: GraphAuth = { apiKey: '' },
	fetchImpl: typeof fetch = fetch,
): Promise<MakerMandates> {
	const id = maker.toLowerCase()
	const mandates: Mandate[] = []
	for (let skip = 0; ; skip += PAGE) {
		const raw = await query<Raw>(
			subgraph,
			auth,
			MANDATES,
			{ maker: id, first: PAGE, skip },
			fetchImpl,
		)
		const page = toMandates(raw)
		mandates.push(...page)
		if (page.length < PAGE) break
	}
	return {
		maker: id,
		mandates,
		active: mandates.filter((m) => m.active).length,
		spendable: spendable(mandates),
	}
}
