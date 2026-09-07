import { describe, expect, test } from 'bun:test'
import { isSpendable, mandatesFor, spendableTotal, toMandates } from './mandates'
import { HELICO_AQUA } from './types'

const ARB = '0x912ce59144191c1204e64559fe8253a0e49e6548'
const USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831'

const balance = (token: string, amount: string, tokensCount: number) => ({
	token,
	amount,
	tokensCount,
})

const mandate = (id: string, balances: ReturnType<typeof balance>[], active = true) => ({
	id,
	strategyHash: `0x${id.slice(-64)}`,
	strategy: '0xdeadbeef',
	shippedAt: '1763834101',
	active,
	app: { id: '0x2060e888ec465bc70b05c84b53d99bfbfd058821' },
	balances,
})

const respond = (pages: unknown[]) => {
	let i = 0
	return (async () => {
		const body = JSON.stringify({ data: pages[Math.min(i++, pages.length - 1)] })
		return new Response(body, { status: 200 })
	}) as unknown as typeof fetch
}

describe("Aqua's sentinel, which is what stops the balance lying", () => {
	test('only 1 to 254 is a live allowance', () => {
		expect(isSpendable(0)).toBe(false) // never shipped
		expect(isSpendable(1)).toBe(true)
		expect(isSpendable(254)).toBe(true)
		expect(isSpendable(255)).toBe(false) // docked
	})

	// The one that matters. `dock` zeroes the ledger on chain and emits no per-token event, so a
	// client reading the amount alone would report a revoked allowance as spendable the moment
	// anything ever leaves a non-zero number behind it.
	test('a docked balance is not spendable however much it says', () => {
		const [m] = toMandates({
			mandates: [mandate('0xaa', [balance(ARB, '1000000000000000000', 255)])],
		})
		expect(m.balances[0].spendable).toBe(false)
		expect(spendableTotal([m], ARB)).toBe(0n)
	})
})

describe('reading what the subgraph answers', () => {
	// 1 ARB is 1e18. Number starts losing whole units above 2^53, so a token amount that came
	// back as a string must not pass through Number on the way in.
	test('token amounts survive as bigint, not number', () => {
		const [m] = toMandates({
			mandates: [mandate('0xaa', [balance(ARB, '4545867806164196746', 2)])],
		})
		expect(m.balances[0].amount).toBe(4545867806164196746n)
		expect(typeof m.balances[0].amount).toBe('bigint')
		// Proof that the detour through Number would have cost real units. Comparing against the
		// literal cannot show this -- the literal is itself rounded when the file is parsed -- so
		// the round trip is what has to be measured.
		expect(BigInt(Number(m.balances[0].amount))).not.toBe(m.balances[0].amount)
	})

	test('spendable totals sum only live balances, per token', () => {
		const ms = toMandates({
			mandates: [
				mandate('0xaa', [balance(ARB, '100', 2), balance(USDC, '5', 2)]),
				mandate('0xbb', [balance(ARB, '50', 1)]),
				mandate('0xcc', [balance(ARB, '999', 255)]), // docked
			],
		})
		expect(spendableTotal(ms, ARB)).toBe(150n)
		expect(spendableTotal(ms, USDC)).toBe(5n)
	})

	test('a token nobody holds is zero rather than undefined', () => {
		const ms = toMandates({ mandates: [mandate('0xaa', [balance(ARB, '100', 2)])] })
		expect(spendableTotal(ms, USDC)).toBe(0n)
	})
})

describe('paging, because a prefix of the answer is worse than an error', () => {
	test('a short page ends it', async () => {
		const got = await mandatesFor(HELICO_AQUA[42161], '0xMAKER', {
			pageSize: 2,
			fetchImpl: respond([{ mandates: [mandate('0xaa', [])] }]),
		})
		expect(got.length).toBe(1)
	})

	// A full page means there may be more. Stopping there would silently decide against an
	// allowance the caller cannot see.
	test('a full page is followed, and the cursor advances', async () => {
		const got = await mandatesFor(HELICO_AQUA[42161], '0xMAKER', {
			pageSize: 2,
			fetchImpl: respond([
				{ mandates: [mandate('0xaa', []), mandate('0xbb', [])] },
				{ mandates: [mandate('0xcc', [])] },
			]),
		})
		expect(got.map((m) => m.id)).toEqual(['0xaa', '0xbb', '0xcc'])
	})
})

describe('the Studio endpoint', () => {
	// Sending a gateway key to an unauthenticated URL spends it where it buys nothing, and puts
	// a secret in a request that did not need one.
	test('is queried without a key, and without an Authorization header', async () => {
		let sent: Headers | undefined
		const spy = (async (_url: string, init: RequestInit) => {
			sent = new Headers(init.headers)
			return new Response(JSON.stringify({ data: { mandates: [] } }), { status: 200 })
		}) as unknown as typeof fetch

		await mandatesFor(HELICO_AQUA[42161], '0xMAKER', { fetchImpl: spy })

		expect(sent?.has('authorization')).toBe(false)
	})

	test('is the subgraph we deployed, not the gateway', () => {
		expect(HELICO_AQUA[42161].studioUrl).toContain('api.studio.thegraph.com')
		expect(HELICO_AQUA[42161].id).toBeUndefined()
	})
})
