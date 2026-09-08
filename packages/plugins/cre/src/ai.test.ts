import { describe, expect, test } from 'bun:test'
import {
	completionHttpRequest,
	completionRequest,
	describeForOwner,
	rayToPercent,
	usableAnswer,
} from './ai'

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
	const venue = {
		pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
		asset: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
	}
	const policy = {
		targetWorkingBps: 8_000,
		minIdleAmount: 100_000_000n,
		minMoveAmount: 25_000_000n,
		minMoveBps: 50,
		maxMoveAmount: 1_000_000_000_000n,
	}
	const state = {
		idle: 1_000_000_000n,
		supplied: 0n,
		venueLiquidity: 29_318_183_885_841n,
		supplyRateRay: 27_514_566_416_591_863_466_760_475n,
	}
	const split = {
		total: 1_000_000_000n,
		wantIdle: 200_000_000n,
		wantWorking: 800_000_000n,
		deadband: 25_000_000n,
	}

	test('hands the model the decision, so it explains rather than decides', () => {
		const prompt = describeForOwner(venue, policy, state, split, {
			act: true,
			params: { amount: 800_000_000n, supply: true },
		})
		expect(prompt).toContain('Decision: supply 800000000')
		expect(prompt).toContain('paying 2.75%')
		expect(prompt).toContain('80% of it should be working')
		expect(prompt).toContain('target at 800000000 working and 200000000 idle')
		expect(prompt).toContain('smallest move worth making 25000000')
	})

	test('names the other direction as a withdrawal, not as a negative supply', () => {
		const prompt = describeForOwner(venue, policy, state, split, {
			act: true,
			params: { amount: 190_000_000n, supply: false },
		})
		expect(prompt).toContain('Decision: withdraw 190000000')
		expect(prompt).not.toContain('supply 190000000')
	})

	test('says plainly when nothing happened, and why', () => {
		const prompt = describeForOwner(venue, policy, state, split, {
			act: false,
			reason: 'inside the deadband',
		})
		expect(prompt).toContain('Decision: do nothing this run, because inside the deadband')
	})

	/**
	 * The model is handed the deadband and the target, not just the balances, because "nothing
	 * happened" is only explicable next to the number the move would have had to clear.
	 */
	test('carries the numbers a hold has to be justified against', () => {
		const prompt = describeForOwner(venue, policy, state, split, {
			act: false,
			reason: 'inside the deadband',
		})
		expect(prompt).toContain('1000000000 idle')
		expect(prompt).toContain('0 supplied')
		expect(prompt).toContain('able to pay out 29318183885841')
	})
})

describe('rayToPercent', () => {
	test('reads a ray as a percentage, and rounds only the prose', () => {
		expect(rayToPercent(27_514_566_416_591_863_466_760_475n)).toBe('2.75%')
		expect(rayToPercent(10n ** 27n)).toBe('100%')
		expect(rayToPercent(0n)).toBe('0%')
	})
})

/**
 * The request options, which had a bug that no test could see and the simulator reported as
 * silence: `timeout` was `{ seconds: '30' }`, an object, where a `google.protobuf.Duration` in
 * JSON is the string `'30s'`. The call threw before it left, `explain` caught it, and a report
 * with no prose is exactly what the design says a missing answer looks like — so the whole
 * system agreed nothing was wrong for a day.
 *
 * `completionRequest` was already split out so its body could be asserted without a runtime.
 * The envelope needed the same treatment and did not have it.
 */
describe('completionHttpRequest', () => {
	const config = {
		aiUrl: 'https://router.example/v1/chat/completions',
		aiModel: 'a',
		aiFallbackModel: 'b',
		aiMaxTokens: 1200,
		aiTimeoutSeconds: 30,
	}

	test('the timeout is a Duration string, not an object', () => {
		const req = completionHttpRequest(config, 'YmFzaWM=', 'sk-x', '{}')
		expect(typeof req.timeout).toBe('string')
		expect(req.timeout).toMatch(/^\d+s$/)
		expect(req.timeout).toBe('30s')
	})

	test('the two auth layers are on separate headers', () => {
		const req = completionHttpRequest(config, 'YmFzaWM=', 'sk-x', '{}')
		expect(req.multiHeaders.Authorization.values).toEqual(['Basic YmFzaWM='])
		expect(req.multiHeaders['x-api-key'].values).toEqual(['sk-x'])
	})

	test('the body is base64, because the capability wants bytes', () => {
		const req = completionHttpRequest(config, 'YmFzaWM=', 'sk-x', '{"model":"a"}')
		expect(atob(req.body)).toBe('{"model":"a"}')
	})
})
