import { describe, expect, test } from 'bun:test'
import type { IdlePolicy } from './policy'
import {
	accountsFromResponse,
	accountsNote,
	accountsToManage,
	bufferNote,
	demandFromResponse,
	demandHttpRequest,
	MANDATE_DEMAND,
	MAX_BALANCE_ROWS,
	type MandateDemand,
	withMandateBuffer,
} from './subgraph'

/** USDC has six decimals, so every amount below is `whole * 1e6`. */
const usdc = (whole: number): bigint => BigInt(whole) * 1_000_000n

const policy: IdlePolicy = {
	targetWorkingBps: 8_000,
	minIdleAmount: usdc(100),
	minMoveAmount: usdc(25),
	minMoveBps: 50,
	minSupplyRateRay: 0n,
	maxMoveAmount: usdc(1_000_000),
	expiry: 2_000_000_000,
}

const config = {
	subgraphUrl: 'https://api.studio.thegraph.com/query/1758877/helico-arbitrum-one/version/latest',
	subgraphTimeoutSeconds: 20,
}

/**
 * A maker address, used only to shape the request these tests assert on — no live call is made.
 *
 * It is deliberately not described as ours. The first version of this comment called it "Helico's
 * account on Arbitrum One", which was wrong twice over: it is somebody else's, and it lives on the
 * Aqua deployment 1inch stopped using. The live subgraph was serving that contract's history at the
 * time, so a figure measured against it looked like verification and was not. A real maker on the
 * canonical Aqua is `0xef9f7f4006fe95afede04f6916e72556a957ebbc`, with 11 active mandates.
 */
const MAKER = '0xd435ade7ea030f988c24eb87ba4a4ace31aa04a8'
const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'

const answer = (balances: { amount: string; tokensCount: number }[]) =>
	JSON.stringify({ data: { balances } })

const row = (amount: string, tokensCount = 2) => ({ amount, tokensCount })

describe('demandHttpRequest', () => {
	/**
	 * The same bug `completionHttpRequest` had, in the same position: `timeout` is a
	 * `google.protobuf.Duration`, which in JSON is the string `"30s"`. The object form
	 * type-checks and is discarded at run time, and the call never leaves the enclave.
	 */
	test('the timeout is a Duration string, not an object', () => {
		const req = demandHttpRequest(config, MAKER, USDC)
		expect(typeof req.timeout).toBe('string')
		expect(req.timeout).toBe('20s')
	})

	test('the body is base64, because the capability wants bytes', () => {
		const req = demandHttpRequest(config, MAKER, USDC)
		const body = JSON.parse(atob(req.body))
		expect(body.query).toBe(MANDATE_DEMAND)
		expect(req.method).toBe('POST')
		expect(req.multiHeaders['Content-Type']?.values).toEqual(['application/json'])
	})

	/**
	 * The subgraph stores addresses lower-cased, and a checksummed one matches nothing and comes
	 * back as an **empty list rather than an error** — so a maker with fifty mandates would read
	 * as a maker with none, and the buffer would silently stay at the policy floor.
	 */
	test('both addresses are lower-cased before they are sent', () => {
		const req = demandHttpRequest(config, MAKER.toUpperCase().replace('0X', '0x'), USDC)
		const { variables } = JSON.parse(atob(req.body))
		expect(variables.maker).toBe(MAKER)
		expect(variables.token).toBe(USDC.toLowerCase())
	})

	/** No key. This is a Studio endpoint; a bearer header with an empty key authenticates nothing. */
	test('no Authorization header is sent to Studio', () => {
		const req = demandHttpRequest(config, MAKER, USDC)
		expect(req.multiHeaders.Authorization).toBeUndefined()
	})

	test('never asks for more than one page', () => {
		const { variables } = JSON.parse(atob(demandHttpRequest(config, MAKER, USDC).body))
		expect(variables.first).toBe(MAX_BALANCE_ROWS)
	})
})

/**
 * The bound, measured rather than argued. `ConfHTTP resp=500kb` is what the simulator prints, and
 * the reason the query does not reuse `makerMandates` verbatim is that its `strategy` field makes
 * a page far larger than this: measured against the live subgraph on 8 September 2026, 38
 * mandates came back as 41,303 bytes, so a full 1000-row page of them would be over a megabyte.
 */
describe('the response bound', () => {
	const LIMIT = 500 * 1024

	test('a full page of the worst rows this query can produce stays inside 500 kB', () => {
		// The largest a row can be: a `uint256` at its maximum and a three-digit sentinel.
		const worst = row((2n ** 256n - 1n).toString(), 254)
		const body = answer(Array.from({ length: MAX_BALANCE_ROWS }, () => worst))
		expect(new TextEncoder().encode(body).length).toBeLessThan(LIMIT)
	})

	/**
	 * And the page that would not have fit, for contrast: the same 1000 mandates carrying the 578
	 * hex characters of `strategy` that `@helico/plugin-thegraph` asks for.
	 */
	test('the mandate query this replaces would not have', () => {
		const mandate = {
			strategyHash: `0x${'ab'.repeat(32)}`,
			strategy: `0x${'cd'.repeat(288)}`,
			active: true,
			movementCount: 26,
			shippedAt: '1776362754',
			app: { id: `0x${'ef'.repeat(20)}` },
			balances: [
				{ token: USDC, amount: '15000030', tokensCount: 2, totalPulled: '0', totalPushed: '0' },
			],
		}
		const body = JSON.stringify({
			data: { mandates: Array.from({ length: MAX_BALANCE_ROWS }, () => mandate) },
		})
		expect(new TextEncoder().encode(body).length).toBeGreaterThan(LIMIT)
	})
})

describe('demandFromResponse', () => {
	/**
	 * The live answer, recorded on 8 September 2026 from
	 * `helico-arbitrum-one/version/latest` for maker `0xd435…04a8` and USDC. Eight balances carry
	 * an amount and five are spent to zero; all thirteen are spendable, and the sum is what the
	 * mandates could still ask for.
	 */
	test('sums the live answer', () => {
		const live = answer([
			row('16230195'),
			row('16000000'),
			row('16000000'),
			row('15880800'),
			row('15880704'),
			row('15780704'),
			row('15000036'),
			row('15000030'),
			row('0'),
			row('0'),
			row('0'),
			row('0'),
			row('0'),
		])
		const demand = demandFromResponse(live)
		expect(demand).toEqual({ known: true, amount: 125_772_469n, balances: 13, complete: true })
	})

	/**
	 * Aqua's three-state sentinel, which is the only honest answer to "can this token still be
	 * spent?". `dock` zeroes the ledger on chain and emits nothing per token, so a docked balance
	 * can carry an amount and must still not count.
	 */
	test('counts 1 to 254 and refuses 0 and 255', () => {
		const demand = demandFromResponse(
			answer([row('100', 1), row('200', 254), row('400', 0), row('800', 255)]),
		)
		expect(demand).toEqual({ known: true, amount: 300n, balances: 2, complete: true })
	})

	/** The trap: a double cannot hold this number, and the loss would be silent. */
	test('amounts survive as bigint rather than losing their tail to a double', () => {
		const raw = '16577240263528345757'
		const demand = demandFromResponse(answer([row(raw)]))
		expect(demand.known && String(demand.amount)).toBe(raw)
		expect(String(Number(raw))).not.toBe(raw)
	})

	/**
	 * A maker with nothing live in this asset. Not an error, and reported as a fact about the
	 * maker rather than about the index — the buffer is the same either way, the sentence is not.
	 */
	test('an empty list is an answer, not a failure', () => {
		expect(demandFromResponse(answer([]))).toEqual({
			known: true,
			amount: 0n,
			balances: 0,
			complete: true,
		})
	})

	/** A full page may be a prefix, so the sum is a floor rather than the total. */
	test('a full page is never mistaken for the whole', () => {
		const full = answer(Array.from({ length: MAX_BALANCE_ROWS }, () => row('1')))
		const demand = demandFromResponse(full)
		expect(demand).toEqual({
			known: true,
			amount: BigInt(MAX_BALANCE_ROWS),
			balances: MAX_BALANCE_ROWS,
			complete: false,
		})
	})

	/**
	 * A GraphQL endpoint answers 200 with an `errors` array for a query it refused. The message
	 * below is the live subgraph's own, for a `where` argument it does not understand.
	 */
	test('refuses a 200 that carries errors instead of data', () => {
		const body = JSON.stringify({
			errors: [{ message: 'Invalid value provided for argument `where`' }],
		})
		expect(demandFromResponse(body)).toEqual({
			known: false,
			reason: 'answered Invalid value provided for argument `where`',
		})
	})

	test.each([
		['a body that is not JSON', 'gateway timeout', 'answered something that is not JSON'],
		['a 200 with neither data nor errors', '{}', 'answered a 200 with no balances'],
		[
			'a 200 whose data is for another query',
			'{"data":{"mandates":[]}}',
			'answered a 200 with no balances',
		],
	])('refuses %s', (_, raw, reason) => {
		expect(demandFromResponse(raw)).toEqual({ known: false, reason })
	})

	/**
	 * The whole read fails rather than the one row being skipped. A partial sum is
	 * indistinguishable from a smaller portfolio, and this is the number an agent is supposed to
	 * be able to act on.
	 */
	test('one unreadable amount fails the read rather than being skipped', () => {
		const demand = demandFromResponse(answer([row('100'), row('not a number')]))
		expect(demand).toEqual({ known: false, reason: 'answered an amount that is not a number' })
	})
})

describe('withMandateBuffer', () => {
	const known = (amount: bigint, balances = 1, complete = true): MandateDemand => ({
		known: true,
		amount,
		balances,
		complete,
	})

	test('raises the floor to what the mandates could demand', () => {
		expect(withMandateBuffer(policy, known(usdc(400))).minIdleAmount).toBe(usdc(400))
	})

	/**
	 * The one direction that must never happen. The owner's minimum is a minimum: an index that
	 * reports less than it — behind the chain, or filtered wrongly — has nothing to say about a
	 * number the owner set themselves.
	 */
	test('never lowers it, whatever the subgraph says', () => {
		expect(withMandateBuffer(policy, known(usdc(1))).minIdleAmount).toBe(usdc(100))
		expect(withMandateBuffer(policy, known(0n, 0)).minIdleAmount).toBe(usdc(100))
		expect(
			withMandateBuffer(policy, { known: false, reason: 'could not be reached' }).minIdleAmount,
		).toBe(usdc(100))
	})

	/** A page that may be a prefix still raises: a floor from part of the truth is still a floor. */
	test('a partial page still raises the floor', () => {
		expect(withMandateBuffer(policy, known(usdc(400), 1000, false)).minIdleAmount).toBe(usdc(400))
	})

	/** Nothing else about the owner's policy is touched — this changes one number and no other. */
	test('leaves every other threshold exactly as the owner set it', () => {
		const raised = withMandateBuffer(policy, known(usdc(400)))
		expect({ ...raised, minIdleAmount: policy.minIdleAmount }).toEqual(policy)
	})

	test('an unknown answer returns the same object, not a copy of it', () => {
		expect(withMandateBuffer(policy, { known: false, reason: 'is not configured' })).toBe(policy)
	})
})

describe('bufferNote', () => {
	test('names both numbers when the subgraph answered, whichever won', () => {
		expect(
			bufferNote(policy, { known: true, amount: usdc(400), balances: 13, complete: true }),
		).toBe('buffer 400000000: policy floor 100000000, 13 live Aqua balances could demand 400000000')
		expect(bufferNote(policy, { known: true, amount: usdc(1), balances: 1, complete: true })).toBe(
			'buffer 100000000: policy floor 100000000, 1 live Aqua balance could demand 1000000',
		)
	})

	test('says when the page was full, because the number is then a floor', () => {
		expect(
			bufferNote(policy, { known: true, amount: usdc(400), balances: 1000, complete: false }),
		).toEndWith('; a full page, so there may be more')
	})

	/**
	 * The fact worth having when a later swap cannot be covered: the buffer was the owner's own
	 * number because the index was not consulted, not because the mandates asked for nothing.
	 */
	test('says plainly when the floor is the policy alone, and why', () => {
		expect(bufferNote(policy, { known: false, reason: 'answered HTTP 502' })).toBe(
			'buffer 100000000: policy floor only, the subgraph answered HTTP 502',
		)
	})
})

describe('the accounts the enclave manages', () => {
	const A = '0xAAaaAAaAaaAAAAAaaAAaAAaAaaaAAaaAaAaAAaaA'
	const B = '0xbbBBbbbbBBBbbBBbBBbBBbBbBBbBbBbbbbbbBBBB'
	const answer = (ids: string[]) =>
		JSON.stringify({ data: { accounts: ids.map((id) => ({ id, owner: id })) } })

	test('reads the list, lower-cased, in the order the index returned it', () => {
		expect(accountsFromResponse(answer([A, B]))).toEqual({
			known: true,
			accounts: [A.toLowerCase(), B.toLowerCase()],
			complete: true,
		})
	})

	test('an empty index is an answer, not a failure', () => {
		expect(accountsFromResponse(answer([]))).toEqual({
			known: true,
			accounts: [],
			complete: true,
		})
	})

	/**
	 * The same three shapes `demandFromResponse` refuses, and for the same reason: a partial list
	 * is indistinguishable from a smaller one, and this list decides which owners get an agent.
	 */
	test.each([
		['not JSON', '<html>504</html>', 'answered something that is not JSON'],
		[
			'a 200 with errors',
			'{"errors":[{"message":"indexers not available"}]}',
			'answered indexers not available',
		],
		['a 200 with no accounts', '{"data":{}}', 'answered a 200 with no accounts'],
		[
			'a row that is not an address',
			'{"data":{"accounts":[{"id":"not-an-address","owner":"0x00"}]}}',
			'answered an account that is not an address',
		],
	])('refuses %s', (_, body, reason) => {
		expect(accountsFromResponse(body)).toEqual({ known: false, reason })
	})

	/**
	 * The union, and the case it exists for: an account opened moments ago is real and absent from
	 * the index, and the one config names is the demo account this workflow was deployed for.
	 */
	test('the configured account is managed even when the index has never heard of it', () => {
		expect(
			accountsToManage(A, { known: true, accounts: [B.toLowerCase()], complete: true }, 25),
		).toEqual([A.toLowerCase(), B.toLowerCase()])
	})

	test('the configured account is not managed twice when the index also returns it', () => {
		const both = {
			known: true as const,
			accounts: [A.toLowerCase(), B.toLowerCase()],
			complete: true,
		}
		expect(accountsToManage(A, both, 25)).toEqual([A.toLowerCase(), B.toLowerCase()])
	})

	test('a checksummed address in config does not become a second account', () => {
		const lower = { known: true as const, accounts: [A.toLowerCase()], complete: true }
		expect(accountsToManage(A, lower, 25)).toEqual([A.toLowerCase()])
	})

	test('an index that did not answer leaves exactly the configured account', () => {
		expect(accountsToManage(A, { known: false, reason: 'could not be reached' }, 25)).toEqual([
			A.toLowerCase(),
		])
	})

	const NONE = `0x${'0'.repeat(40)}`

	test('the note says where the list came from, both ways', () => {
		expect(accountsNote([A], { known: false, reason: 'could not be reached' }, A)).toBe(
			'1 account: config only, the subgraph could not be reached',
		)
		expect(
			accountsNote([A, B], { known: true, accounts: [B.toLowerCase()], complete: true }, A),
		).toBe('2 accounts: 1 indexed plus the one in config')
	})

	/**
	 * The case a length comparison gets wrong: an anchor the index also returned leaves the two
	 * lists the same size, and inferring from that would deny the anchor on exactly the runs where
	 * it was doing its job.
	 */
	test('an anchor the index also returned is still reported as an anchor', () => {
		const both = { known: true as const, accounts: [A.toLowerCase()], complete: true }
		expect(accountsNote([A.toLowerCase()], both, A)).toBe(
			'1 account: 1 indexed plus the one in config',
		)
	})

	test('with no anchor the note credits the index alone', () => {
		const only = { known: true as const, accounts: [B.toLowerCase()], complete: true }
		expect(accountsNote([B.toLowerCase()], only, NONE)).toBe('1 account: 1 indexed')
	})

	/**
	 * No anchor and no index is the one configuration that manages nothing, and it says so rather
	 * than reporting zero accounts as though that were a fleet.
	 */
	test('no anchor and an index that did not answer manages nothing, and says so', () => {
		const down = { known: false as const, reason: 'could not be reached' }
		expect(accountsToManage(NONE, down, 25)).toEqual([])
		expect(accountsNote([], down, NONE)).toBe(
			'0 accounts: nothing to manage, the subgraph could not be reached',
		)
	})

	/**
	 * `open` is permissionless, so anyone may create accounts faster than a run can read them.
	 * The bound is why the anchor exists at all beyond an outage: it is added first, so the
	 * account a demo depends on cannot be crowded out of its own run by strangers.
	 */
	test('the limit bounds the run, and the anchor is inside it rather than subject to it', () => {
		const many = Array.from({ length: 5 }, (_, i) => `0x${(i + 1).toString().padStart(40, '0')}`)
		const indexed = { known: true as const, accounts: many, complete: true }
		expect(accountsToManage(A, indexed, 3)).toEqual([A.toLowerCase(), many[0], many[1]])
		expect(accountsToManage(NONE, indexed, 3)).toEqual([many[0], many[1], many[2]])
	})

	test('what the limit left out is said, never silently dropped', () => {
		const many = Array.from({ length: 5 }, (_, i) => `0x${(i + 1).toString().padStart(40, '0')}`)
		const indexed = { known: true as const, accounts: many, complete: true }
		const managed = accountsToManage(NONE, indexed, 3)
		expect(accountsNote(managed, indexed, NONE)).toBe(
			"3 accounts: 5 indexed, 2 beyond this run's limit",
		)
	})

	test('a full page says there are more, because the run cannot see them', () => {
		expect(
			accountsNote([A, B], { known: true, accounts: [B.toLowerCase()], complete: false }, A),
		).toBe('2 accounts: 1 indexed plus the one in config; a full page, so there are more')
	})
})
