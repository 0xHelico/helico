import type { GraphAuth } from './client'
import { query } from './client'
import type { Mandate, MandateBalance, Subgraph } from './types'

/**
 * A maker's strategies on Aqua, with what is left of each.
 *
 * Written as a top-level `mandates` query rather than the nicer-reading
 * `maker(id: $maker) { mandates { ... } }`, and the difference matters. A nested list silently
 * defaults to 100 entries with no `pageInfo`, no `totalCount` and no cursor — nothing in the
 * response distinguishes "100 mandates" from "100 of 5000". The top-level form takes `id_gt`,
 * which is a cursor, so this can page and know when it is done.
 *
 * `balances` stays nested and is safe there: Aqua caps a strategy at 254 tokens, well under the
 * 1000 ceiling.
 */
const MANDATES = `
  query MakerMandates($maker: Bytes!, $cursor: Bytes!, $first: Int!) {
    mandates(
      where: { maker: $maker, id_gt: $cursor }
      orderBy: id
      orderDirection: asc
      first: $first
    ) {
      id
      strategyHash
      strategy
      shippedAt
      active
      app { id }
      balances(first: 254) {
        token
        amount
        tokensCount
      }
    }
  }
`

type RawBalance = { token: string; amount: string; tokensCount: number }
type RawMandate = {
	id: string
	strategyHash: string
	strategy: string
	shippedAt: string
	active: boolean
	app: { id: string }
	balances: RawBalance[]
}
type Raw = { mandates: RawMandate[] }

/**
 * Aqua's sentinel, read as the question a caller actually has.
 *
 * 0 means the token was never shipped under this strategy and 255 means it was docked. Only the
 * range between is a live allowance — and a docked balance reads `0` anyway, so relying on the
 * amount alone would be right by accident here and wrong the moment it is not.
 */
export function isSpendable(tokensCount: number): boolean {
	return tokensCount > 0 && tokensCount < 255
}

/** The subgraph answers numbers as strings. Token amounts become `bigint`, never `number`. */
export function toMandates(raw: Raw): Mandate[] {
	return raw.mandates.map((m) => ({
		id: m.id,
		strategyHash: m.strategyHash,
		strategy: m.strategy,
		app: m.app.id,
		active: m.active,
		shippedAt: Number(m.shippedAt),
		balances: m.balances.map(
			(b): MandateBalance => ({
				token: b.token,
				amount: BigInt(b.amount),
				tokensCount: Number(b.tokensCount),
				spendable: isSpendable(Number(b.tokensCount)),
			}),
		),
	}))
}

/**
 * Every mandate a maker has under one app, paged to the end.
 *
 * Pages rather than taking the first thousand, because a caller that silently sees a prefix of
 * the answer is worse off than one that sees an error: it would decide against an allowance it
 * cannot see. The loop stops when a page comes back short, which is the only honest signal the
 * API gives.
 */
export async function mandatesFor(
	subgraph: Subgraph,
	maker: string,
	options: { auth?: GraphAuth; fetchImpl?: typeof fetch; pageSize?: number } = {},
): Promise<Mandate[]> {
	const first = options.pageSize ?? 500
	const all: Mandate[] = []
	let cursor = '0x'

	for (;;) {
		const raw = await query<Raw>(
			subgraph,
			options.auth ?? { apiKey: '' },
			MANDATES,
			{ maker: maker.toLowerCase(), cursor, first },
			options.fetchImpl ?? fetch,
		)
		const page = toMandates(raw)
		all.push(...page)
		if (page.length < first) {
			return all
		}
		cursor = page[page.length - 1].id
	}
}

/**
 * What this maker can actually spend of one token, across every mandate they hold with an app.
 *
 * Sums only the balances Aqua still considers live. This is the number an agent needs before it
 * acts, and the one nothing on chain can produce: `rawBalances` answers for a strategy hash you
 * already know, and there is no way to enumerate the hashes.
 */
export function spendableTotal(mandates: Mandate[], token: string): bigint {
	const want = token.toLowerCase()
	let total = 0n
	for (const m of mandates) {
		for (const b of m.balances) {
			if (b.spendable && b.token.toLowerCase() === want) {
				total += b.amount
			}
		}
	}
	return total
}
