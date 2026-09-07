import { bytesToBase64, cre, ok, type TeeRuntime, text } from '@chainlink/cre-sdk'

/**
 * The enclave explaining its own verdict, in words the account's owner can read.
 *
 * **This decides nothing.** `decide` has already chosen, and the account enforces the shape of
 * what an agent may ask for whatever this says. A confused model writes a confusing sentence; it
 * cannot move a single unit of anyone's capital.
 *
 * **Why it is here and can be nowhere else.** A non-confidential CRE workflow calls an HTTP
 * endpoint from every node and takes a consensus of the answers. Ten nodes asking a language
 * model the same question get ten different answers, and free text has no median. Inside
 * `handlerInTee` the call happens once and the single result is trusted, which is the only
 * arrangement a model fits into.
 */

/** Vault DON secret ids holding the router's two auth layers. */
export const AI_SECRET_IDS = {
	username: 'AI_USERNAME',
	password: 'AI_PASSWORD',
	apiKey: 'AI_API_KEY',
} as const

export type AiConfig = {
	/** Chat-completions endpoint, OpenAI-shaped. */
	aiUrl: string
	aiModel: string
	/** Tried when the first model errors, times out, or returns something the guards reject. */
	aiFallbackModel: string
	aiMaxTokens: number
	aiTimeoutSeconds: number
}

/**
 * Router notices that arrive dressed as answers.
 *
 * Three models on this router return `Gemini 3.5 Flash is no longer available…` with
 * `finish_reason: "stop"` and no completion tokens — a successful HTTP 200 whose body is an
 * operator message. Matched on the prefix rather than the whole string, because the tail of it
 * names a product version that will change.
 */
const ROUTER_NOTICES = ['is no longer available', 'please switch to', 'model not found']

const SYSTEM_PROMPT =
	'You explain one idle-capital decision to the account owner in at most three sentences. ' +
	'State only what the data supports. No advice, no hedging, no markdown, no invented numbers.'

type Choice = { finish_reason?: string; message?: { content?: string } }
type Completion = {
	choices?: Choice[]
	usage?: { completion_tokens?: number }
}

/**
 * The one place a model's answer is allowed to become a fact.
 *
 * Every rejection here was seen from this router today, and each one arrives as HTTP 200:
 *
 *  - `finish_reason: "max_tokens"` — `gemini-pro-agent` spent 207 of 220 tokens thinking and
 *    returned nine, cut off mid-sentence, with no error anywhere.
 *  - no completion tokens — what the four broken models look like from the outside.
 *  - a router notice in the text — see `ROUTER_NOTICES`.
 *
 * Returning `undefined` is not a failure. The verdict stands and the report goes out without
 * prose, because the prose was never load-bearing.
 */
export function usableAnswer(raw: string): string | undefined {
	let body: Completion
	try {
		body = JSON.parse(raw) as Completion
	} catch {
		return undefined
	}

	const choice = body.choices?.[0]
	if (choice?.finish_reason !== 'stop') return undefined
	if (!body.usage?.completion_tokens) return undefined

	const content = choice.message?.content?.trim()
	if (!content) return undefined

	const lower = content.toLowerCase()
	if (ROUTER_NOTICES.some((notice) => lower.includes(notice))) return undefined

	return content
}

/** The request body. Split out so a test can assert `stream` is false without a runtime. */
export function completionRequest(model: string, prompt: string, maxTokens: number): string {
	return JSON.stringify({
		model,
		// Several models on this router stream `data: {...}` unless told not to, and a JSON
		// parser sees garbage. Not a default worth trusting.
		stream: false,
		max_tokens: maxTokens,
		messages: [
			{ role: 'system', content: SYSTEM_PROMPT },
			{ role: 'user', content: prompt },
		],
	})
}

/**
 * The request the HTTP capability is handed, split out for the same reason as
 * `completionRequest`: so a test can assert its shape without a runtime.
 *
 * `timeout` is a `google.protobuf.Duration`, and in JSON that is the **string** `"30s"` — not
 * `{ seconds: "30" }`. The object form type-checks, because `DurationJson` is `string` and an
 * object literal in that position is checked against the surrounding type rather than rejected,
 * and then it is thrown away at run time with
 * `cannot decode message google.protobuf.Duration from JSON: object`. The call never leaves the
 * enclave, the catch below swallows it, and the report goes out without prose — which is exactly
 * what the design says a missing answer should look like, so nothing anywhere said it was broken.
 */
export function completionHttpRequest(
	config: AiConfig,
	basic: string,
	apiKey: string,
	body: string,
): {
	url: string
	method: string
	body: string
	multiHeaders: Record<string, { values: string[] }>
	timeout: string
} {
	return {
		url: config.aiUrl,
		method: 'POST',
		body: bytesToBase64(new TextEncoder().encode(body)),
		multiHeaders: {
			'Content-Type': { values: ['application/json'] },
			// The two layers cannot share a header. nginx wants Basic; the application wants its
			// own. Sending the key as a bearer token replaces the first and everything answers 401.
			Authorization: { values: [`Basic ${basic}`] },
			'x-api-key': { values: [apiKey] },
		},
		timeout: `${config.aiTimeoutSeconds}s`,
	}
}

/**
 * Ask the model, once per configured name, and stop at the first usable answer.
 *
 * The two credentials cannot share a header: nginx wants `Authorization: Basic …` and the
 * application wants `x-api-key`. Sending the key as a bearer token replaces the first and
 * everything answers 401.
 */
export function explain(
	runtime: TeeRuntime<unknown>,
	config: AiConfig,
	secrets: Record<string, { value: string }>,
	prompt: string,
): string | undefined {
	const username = secrets[AI_SECRET_IDS.username]?.value
	const password = secrets[AI_SECRET_IDS.password]?.value
	const apiKey = secrets[AI_SECRET_IDS.apiKey]?.value
	if (!username || !password || !apiKey) return undefined

	// Not `btoa`. The WASM runtime the workflow compiles into does not provide it, and the
	// failure is `workflow execution failed: not a function` at run time with every unit test
	// still green. `bytesToBase64` is the SDK's own, and `chain.ts` already relies on it.
	const basic = bytesToBase64(new TextEncoder().encode(`${username}:${password}`))

	for (const model of [config.aiModel, config.aiFallbackModel]) {
		if (!model) continue
		try {
			const body = completionRequest(model, prompt, config.aiMaxTokens)
			const response = new cre.capabilities.HTTPClient()
				.sendRequest(runtime, completionHttpRequest(config, basic, apiKey, body))
				.result()

			if (!ok(response)) continue
			const answer = usableAnswer(text(response))
			if (answer) return answer
		} catch {
			// A model that errors is a model we do not use this run. The next one is tried, and
			// if none answers the verdict goes out without prose.
		}
	}
	return undefined
}

/**
 * What the model is told. Facts the enclave already read or computed, and nothing else.
 *
 * Deliberately narrow. No prices in dollars, no history, no opinion about the market — the model
 * can only be as wrong as the numbers it is handed, and everything here came from the chain or
 * from the policy the owner set.
 *
 * The verdict is included because the model is explaining a decision already made, not making
 * one. Handing it the answer is what keeps it out of the loop that moves money.
 *
 * Amounts are printed in the asset's own units, undecorated. Dividing by the decimals here would
 * mean the enclave reading them from somewhere, and a prose helper is the wrong place for a
 * number that would then differ from the one in the report.
 */
export function describeForOwner(
	venue: { pool: string; asset: string },
	policy: {
		targetWorkingBps: number
		minIdleAmount: bigint
		minMoveAmount: bigint
		minMoveBps: number
		maxMoveAmount: bigint
	},
	state: { idle: bigint; supplied: bigint; venueLiquidity: bigint; supplyRateRay: bigint },
	split: { total: bigint; wantIdle: bigint; wantWorking: bigint; deadband: bigint },
	outcome:
		| { act: false; reason: string }
		| { act: true; params: { amount: bigint; supply: boolean } },
): string {
	const facts = [
		`Lending market ${venue.pool}, asset ${venue.asset}, paying ${rayToPercent(state.supplyRateRay)} and able to pay out ${state.venueLiquidity} right now.`,
		`The account holds ${state.idle} idle and has ${state.supplied} supplied, ${split.total} in total.`,
		`Policy: ${policy.targetWorkingBps / 100}% of it should be working, never less than ${policy.minIdleAmount} left liquid, no move under ${policy.minMoveAmount} or under ${policy.minMoveBps / 100}% of the total, none over ${policy.maxMoveAmount}.`,
		`That puts the target at ${split.wantWorking} working and ${split.wantIdle} idle, and makes the smallest move worth making ${split.deadband}.`,
	]
	facts.push(
		outcome.act
			? `Decision: ${outcome.params.supply ? 'supply' : 'withdraw'} ${outcome.params.amount}. Explain to the owner why this happens now.`
			: `Decision: do nothing this run, because ${outcome.reason}. Explain to the owner why nothing happened.`,
	)
	return facts.join(' ')
}

const RAY = 10n ** 27n

/**
 * A ray as a percentage with two decimals, for prose only. Nothing reads this back: the decision
 * compares rays to rays, so this rounding cannot move a threshold.
 */
export const rayToPercent = (ray: bigint): string => `${Number((ray * 10_000n) / RAY) / 100}%`
