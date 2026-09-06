import { describe, expect, test } from 'bun:test'
import { completionRequest, describeForOwner, usableAnswer } from './ai'

/**
 * The guards, tested against what the router actually returned rather than against an idea of
 * what a bad response looks like. Every fixture below is a real body, recorded on 2026-09-06,
 * and every one of them arrived as HTTP 200.
 */
describe('usableAnswer', () => {
	/**
	 * A router notice, dressed as an answer. Three models return this — with
	 * `finish_reason: "stop"`, which is what makes it dangerous: nothing about the envelope
	 * says anything is wrong, and without this guard the operator's message becomes the
	 * enclave's reasoning in the run log.
	 */
	const NOTICE =
		'{"id":"chatcmpl-1788701748087","object":"chat.completion","created":1788701748,"model":"gemini","choices":[{"index":0,"message":{"role":"assistant","content":"Gemini 3.5 Flash is no longer available. Please switch to Gemini 3.7 Flash in the latest version of Antigravity."},"finish_reason":"stop"}]}'

	/**
	 * `gemini-pro-agent` at `max_tokens: 220`, which it spends almost entirely on thinking.
	 * The answer stops mid-number, and the guard tests for `finish_reason === 'stop'` rather
	 * than against a list of failure values.
	 */
	const TRUNCATED =
		'{"id":"chatcmpl-NGydarqIM_uSg8UP2J_ygAs","object":"chat.completion","created":1788701752,"model":"gemini-pro-default","choices":[{"index":0,"message":{"role":"assistant","content":"The current tick of 947"},"finish_reason":"max_tokens"}],"usage":{"prompt_tokens":2246,"completion_tokens":8,"total_tokens":2254,"completion_tokens_details":{"reasoning_tokens":208}}}'

	test('refuses a router notice even though the call succeeded', () => {
		// `finish_reason: "stop"` and no `usage` at all — nothing in the envelope says this is
		// not an answer.
		expect(JSON.parse(NOTICE).choices[0].finish_reason).toBe('stop')
		expect(JSON.parse(NOTICE).usage).toBeUndefined()
		expect(usableAnswer(NOTICE)).toBeUndefined()
	})

	/**
	 * The recorded notice above is caught by the token guard before the text is ever read, so
	 * on its own it proves nothing about `ROUTER_NOTICES` — removing that guard leaves every
	 * other test passing. This one gives the same text a complete envelope, which is what the
	 * guard actually exists for: the day a notice arrives with tokens attached.
	 */
	test('refuses a router notice that arrives with a complete envelope', () => {
		const body = JSON.stringify({
			choices: [
				{
					finish_reason: 'stop',
					message: {
						content: 'Gemini 3.5 Flash is no longer available. Please switch to Gemini 3.7 Flash.',
					},
				},
			],
			usage: { completion_tokens: 17 },
		})
		expect(usableAnswer(body)).toBeUndefined()
	})

	test('refuses an answer that ran out of tokens mid-sentence', () => {
		expect(usableAnswer(TRUNCATED)).toBeUndefined()
	})

	test('refuses a completion that produced no tokens', () => {
		const body = JSON.stringify({
			choices: [{ finish_reason: 'stop', message: { content: 'Something.' } }],
			usage: { completion_tokens: 0 },
		})
		expect(usableAnswer(body)).toBeUndefined()
	})

	test('refuses a body that is not JSON at all', () => {
		expect(usableAnswer('data: {"delta":{"content":"streaming"}}')).toBeUndefined()
	})

	test('refuses an empty answer', () => {
		const body = JSON.stringify({
			choices: [{ finish_reason: 'stop', message: { content: '   ' } }],
			usage: { completion_tokens: 12 },
		})
		expect(usableAnswer(body)).toBeUndefined()
	})

	test('accepts a complete answer, trimmed', () => {
		const body = JSON.stringify({
			choices: [
				{ finish_reason: 'stop', message: { content: '  Your position is out of range.  ' } },
			],
			usage: { completion_tokens: 9 },
		})
		expect(usableAnswer(body)).toBe('Your position is out of range.')
	})
})

describe('completionRequest', () => {
	test('always turns streaming off', () => {
		expect(JSON.parse(completionRequest('m', 'p', 100)).stream).toBe(false)
	})

	test('carries the model, the budget and both messages', () => {
		const body = JSON.parse(completionRequest('ag/claude-opus-4-6-thinking', 'why?', 1200))
		expect(body.model).toBe('ag/claude-opus-4-6-thinking')
		expect(body.max_tokens).toBe(1200)
		expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user'])
		expect(body.messages[1].content).toBe('why?')
	})
})

describe('describeForOwner', () => {
	const mandate = {
		rangeWidthTicks: 200,
		minImprovementBps: 100,
		cooldownSeconds: 3600,
		minRetainedBps: 5000,
		expiry: 1_800_000_000,
	}
	const state = {
		tick: 94_703,
		lpFee: 500,
		liquidity: 93_189n,
		tickLower: 93_270,
		tickUpper: 93_470,
		lastActionAt: 1_788_000_000,
	}

	test('hands the model the decision, so it explains rather than decides', () => {
		const prompt = describeForOwner(
			{ poolId: '0xpool' },
			mandate,
			state,
			{
				act: true,
				params: { tickLower: 94_600, tickUpper: 94_800, amountIn: 33n, zeroForOne: false },
			},
			1_788_014_400,
		)
		expect(prompt).toContain('Decision: swap 33 of token1')
		expect(prompt).toContain('mint [94600, 94800)')
		expect(prompt).toContain('retain at least 50')
		expect(prompt).toContain('Last move: 14400 s ago')
	})

	test('says plainly when nothing happened, and why', () => {
		const prompt = describeForOwner(
			{ poolId: '0xpool' },
			mandate,
			state,
			{ act: false, reason: 'cooldown' },
			1_788_000_600,
		)
		expect(prompt).toContain('Decision: do nothing this run, because cooldown')
	})

	test('does not pretend a position that never moved has a last move', () => {
		const prompt = describeForOwner(
			{ poolId: '0xpool' },
			mandate,
			{ ...state, lastActionAt: 0 },
			{ act: false, reason: 'in range' },
			1_788_000_600,
		)
		expect(prompt).toContain('Last move: never moved')
	})
})
