import { describe, expect, test } from 'bun:test'

import { endpoint, query } from './client'
import { makerMandates, spendable, toMandates } from './mandates'
import { HELICO_AQUA, UNISWAP_V4 } from './types'

const AQUA = HELICO_AQUA[42161]
const ARB = '0x912ce59144191c1204e64559fe8253a0e49e6548'
const USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831'

const balance = (token: string, amount: string, tokensCount = 2) => ({
	token,
	amount,
	tokensCount,
	totalPulled: '0',
	totalPushed: amount,
})

const mandate = (over: Record<string, unknown> = {}) => ({
	strategyHash: '0xaa',
	strategy: '0xbeef',
	active: true,
	movementCount: 4,
	shippedAt: '1767250546',
	app: { id: '0x8fdd04dbf6111437b44bbca99c28882434e0958f' },
	balances: [balance(ARB, '16577240263528345757')],
	...over,
})

/** Captures what was fetched, and answers whatever it is given. */
const spy = (data: unknown) => {
	const calls: { url: string; init: RequestInit }[] = []
	const impl = (async (url: string, init: RequestInit) => {
		calls.push({ url, init })
		return new Response(JSON.stringify({ data }), { status: 200 })
	}) as unknown as typeof fetch
	return { calls, impl }
}

describe('Studio and the gateway are different doors', () => {
	test('a Studio subgraph is addressed by its URL, not by an id', () => {
		expect(AQUA.url).toBeDefined()
		expect(endpoint(AQUA)).toBe(AQUA.url as string)
		expect(endpoint(AQUA)).toStartWith('https://api.studio.thegraph.com/')
	})

	test('and a published one still goes to the gateway', () => {
		expect(endpoint(UNISWAP_V4[42161])).toStartWith('https://gateway.thegraph.com/')
	})

	// Studio takes no key. Sending an empty bearer would be refused by some proxies and is a
	// header that says "authenticated" while carrying nothing.
	test('no Authorization header is sent to Studio', async () => {
		const { calls, impl } = spy({ mandates: [] })
		await query(AQUA, { apiKey: '' }, '{ x }', {}, impl)
		const call = calls[0]
		expect(call).toBeDefined()
		expect(call?.url).toBe(AQUA.url as string)
		const headers = (call?.init.headers ?? {}) as Record<string, string>
		expect(headers.Authorization).toBeUndefined()
		expect(headers['Content-Type']).toBe('application/json')
	})

	test('but the gateway is still refused without one', async () => {
		const { impl } = spy({})
		await expect(query(UNISWAP_V4[42161], { apiKey: '' }, '{ x }', {}, impl)).rejects.toThrow(
			/No Graph API key/,
		)
	})
})

describe('reading a maker’s mandates', () => {
	// The subgraph stores addresses lower-cased. A checksummed one matches nothing and returns an
	// empty list rather than an error — a maker with five mandates would read as a maker with none.
	test('the maker address is lower-cased before it is sent', async () => {
		const { calls, impl } = spy({ mandates: [] })
		await makerMandates(AQUA, '0xF54EC0F6996b46b71B8d0c05F8430d2E8ed9413c', undefined, impl)
		const body = JSON.parse(calls[0]?.init.body as string)
		expect(body.variables.maker).toBe('0xf54ec0f6996b46b71b8d0c05f8430d2e8ed9413c')
	})

	// The trap this guards: a double cannot hold this number, and the loss is silent. Written
	// against strings because the wrong literal in a test is exactly as lossy as the wrong code.
	test('amounts survive as bigint rather than losing their tail to a double', () => {
		const raw = '16577240263528345757'
		const [m] = toMandates({ mandates: [mandate()] })
		expect(String(m?.balances[0]?.amount)).toBe(raw)
		expect(String(Number(raw))).not.toBe(raw)
	})

	test('the app and the raw strategy come through undecoded', () => {
		const [m] = toMandates({ mandates: [mandate()] })
		expect(m?.strategy).toBe('0xbeef')
		expect(m?.app).toBe('0x8fdd04dbf6111437b44bbca99c28882434e0958f')
	})

	test('one short page is one request', async () => {
		const { calls, impl } = spy({ mandates: [mandate()] })
		const res = await makerMandates(AQUA, '0xabc', undefined, impl)
		expect(calls.length).toBe(1)
		expect(res.mandates.length).toBe(1)
	})

	// The failure this replaces: `first = 100` returned a prefix and said nothing, so an agent
	// sized a spend against a portfolio it could not see all of. Diagnosis is @ghozzza's, #161.
	test('a full page is followed, and a prefix is never mistaken for the whole', async () => {
		const full = {
			mandates: Array.from({ length: 1000 }, (_, i) => mandate({ strategyHash: `0x${i}` })),
		}
		const calls: unknown[] = []
		const impl = (async (_url: string, init: RequestInit) => {
			calls.push(JSON.parse(init.body as string))
			// Two full pages, then a short one.
			const body = calls.length <= 2 ? full : { mandates: [mandate({ strategyHash: '0xlast' })] }
			return new Response(JSON.stringify({ data: body }), { status: 200 })
		}) as unknown as typeof fetch

		const res = await makerMandates(AQUA, '0xabc', undefined, impl)
		expect(calls.length).toBe(3)
		expect(res.mandates.length).toBe(2001)
		expect((calls[0] as { variables: { skip: number } }).variables.skip).toBe(0)
		expect((calls[2] as { variables: { skip: number } }).variables.skip).toBe(2000)
	})
})

describe('spendable, which is Aqua’s sentinel and not the amount', () => {
	test('255 is docked, however much the ledger still says', () => {
		const [m] = toMandates({
			mandates: [mandate({ balances: [balance(ARB, '1000', 255)] })],
		})
		expect(m?.balances[0]?.amount).toBe(1000n)
		expect(m?.balances[0]?.spendable).toBe(false)
	})

	test('0 is never shipped', () => {
		const [m] = toMandates({ mandates: [mandate({ balances: [balance(ARB, '0', 0)] })] })
		expect(m?.balances[0]?.spendable).toBe(false)
	})

	test('and 1–254 is live', () => {
		const [m] = toMandates({ mandates: [mandate({ balances: [balance(ARB, '5', 1)] })] })
		expect(m?.balances[0]?.spendable).toBe(true)
	})
})

describe('what a maker may still spend', () => {
	const many = () =>
		toMandates({
			mandates: [
				mandate({ balances: [balance(ARB, '100'), balance(USDC, '5')] }),
				mandate({ strategyHash: '0xbb', balances: [balance(ARB, '20')] }),
			],
		})

	test('totals are summed per token across mandates', () => {
		const total = spendable(many())
		expect(total.get(ARB)).toBe(120n)
		expect(total.get(USDC)).toBe(5n)
	})

	test('a docked mandate contributes nothing, even while its ledger reads', () => {
		const mandates = many()
		// biome-ignore lint/style/noNonNullAssertion: the fixture above has two mandates.
		mandates[1]!.active = false
		expect(spendable(mandates).get(ARB)).toBe(100n)
	})

	test('and a docked token inside a live mandate contributes nothing either', () => {
		const mandates = toMandates({
			mandates: [mandate({ balances: [balance(ARB, '100'), balance(USDC, '5', 255)] })],
		})
		expect(spendable(mandates).get(ARB)).toBe(100n)
		expect(spendable(mandates).has(USDC)).toBe(false)
	})
})
