import { describe, expect, test } from 'bun:test'
import { gateway, query } from './client'
import { drifted, summarise, toHours } from './pool'
import { UNISWAP_V4 } from './types'

const hour = (periodStartUnix: number, tick: string | null, feesUSD = '1', volumeUSD = '10') => ({
	periodStartUnix,
	tick,
	feesUSD,
	volumeUSD,
	tvlUSD: '1000',
})

describe('folding hours into evidence', () => {
	test('the tick range is the widest the price actually reached', () => {
		const h = toHours({ poolHourDatas: [hour(3, '120'), hour(2, '-40'), hour(1, '80')] })
		const s = summarise(h)
		expect(s.tickMin).toBe(-40)
		expect(s.tickMax).toBe(120)
		expect(s.hours).toBe(3)
	})

	test('fees and volume are summed, and TVL is the latest hour rather than a sum', () => {
		const h = toHours({
			poolHourDatas: [hour(2, '0', '2.5', '100'), hour(1, '0', '1.5', '50')],
		})
		const s = summarise(h)
		expect(s.feesUSD).toBe(4)
		expect(s.volumeUSD).toBe(150)
		// Summing a stock rather than a flow is the classic way to make this number nonsense.
		expect(s.tvlUSD).toBe(1000)
	})

	// A pool that recorded an hour with no swap has a null tick. Reading that as 0 would put the
	// range around the origin and make a still price look like a violent one.
	test('an hour with no tick is skipped, not read as zero', () => {
		const s = summarise(toHours({ poolHourDatas: [hour(2, null), hour(1, '500')] }))
		expect(s.tickMin).toBe(500)
		expect(s.tickMax).toBe(500)
	})

	test('an empty window is evidence of nothing, not a crash', () => {
		const s = summarise([])
		expect(s.hours).toBe(0)
		expect(s.feesUSD).toBe(0)
		expect(s.tvlUSD).toBe(0)
	})
})

describe('drift, which is the judgement the chain cannot make', () => {
	const history = (tickMin: number, tickMax: number, hours = 24) => ({
		hours,
		tickMin,
		tickMax,
		feesUSD: 0,
		volumeUSD: 0,
		tvlUSD: 0,
	})

	test('a price that stayed inside the range has not drifted', () => {
		expect(drifted(history(-100, 100), -200, 200)).toBe(false)
	})

	test('a price that left it has', () => {
		expect(drifted(history(-100, 300), -200, 200)).toBe(true)
	})

	// The whole point: crossing out and back is oscillation, and re-centring into it sells the
	// position's own volatility. One hour cannot tell the two apart, so it must not try.
	test('too little history answers null rather than guessing', () => {
		expect(drifted(history(-100, 300, 1), -200, 200)).toBeNull()
		expect(drifted(history(0, 0, 0), -200, 200)).toBeNull()
	})
})

describe('the gateway, and the errors it hides inside a 200', () => {
	const ok = (data: unknown) =>
		(async () => new Response(JSON.stringify(data), { status: 200 })) as unknown as typeof fetch

	test('a subgraph id becomes a gateway URL', () => {
		expect(gateway(UNISWAP_V4[42161])).toContain(UNISWAP_V4[42161].id)
		expect(gateway(UNISWAP_V4[42161])).toStartWith('https://gateway.thegraph.com/')
	})

	test('no key is refused here rather than at the gateway', async () => {
		await expect(
			query(UNISWAP_V4[42161], { apiKey: '' }, '{ x }', {}, ok({ data: {} })),
		).rejects.toThrow(/No Graph API key/)
	})

	// GraphQL answers 200 for a query it refused. Checking the status alone reports success for a
	// response that carries no data at all.
	test('a 200 carrying errors is a failure', async () => {
		await expect(
			query(
				UNISWAP_V4[42161],
				{ apiKey: 'k' },
				'{ x }',
				{},
				ok({ errors: [{ message: 'bad query' }] }),
			),
		).rejects.toThrow(/bad query/)
	})

	test('and a 200 carrying neither data nor errors is too', async () => {
		await expect(query(UNISWAP_V4[42161], { apiKey: 'k' }, '{ x }', {}, ok({}))).rejects.toThrow(
			/no data and no errors/,
		)
	})

	test('an HTTP failure never puts the body in the message', async () => {
		const withKeyEchoed = (async () =>
			new Response('{"echo":"Bearer supersecret"}', { status: 500 })) as unknown as typeof fetch
		const err = await query(
			UNISWAP_V4[42161],
			{ apiKey: 'supersecret' },
			'{ x }',
			{},
			withKeyEchoed,
		).catch((e: Error) => e)
		expect((err as Error).message).toContain('HTTP 500')
		expect((err as Error).message).not.toContain('supersecret')
	})
})
