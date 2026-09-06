import { bytesToBase64, cre, ok, type TeeRuntime, text } from '@chainlink/cre-sdk'

/**
 * The enclave explaining its own verdict, in words the position's owner can read.
 *
 * **This decides nothing.** `decide` has already chosen, the vault checks every mandate rule
 * again on chain, and the sentence produced here is not an input to any of it. A confused model
 * writes a confusing sentence; it cannot move a position.
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
	'You explain one liquidity decision to the position owner in at most three sentences. ' +
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
				.sendRequest(runtime, {
					url: config.aiUrl,
					method: 'POST',
					body: bytesToBase64(new TextEncoder().encode(body)),
					multiHeaders: {
						'Content-Type': { values: ['application/json'] },
						// The two layers cannot share a header. nginx wants Basic; the
						// application wants its own. Sending the key as a bearer token
						// replaces the first and every request answers 401.
						Authorization: { values: [`Basic ${basic}`] },
						'x-api-key': { values: [apiKey] },
					},
					timeout: { seconds: String(config.aiTimeoutSeconds) },
				})
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
 * Deliberately narrow. No prices in dollars, no history, no opinion about the market — the
 * model can only be as wrong as the numbers it is handed, and everything here came from the
 * chain or from the mandate the user signed.
 *
 * The verdict is included because the model is explaining a decision already made, not making
 * one. Handing it the answer is what keeps it out of the loop that moves money.
 */
export function describeForOwner(
	pool: { poolId: string },
	mandate: {
		rangeWidthTicks: number
		minImprovementBps: number
		cooldownSeconds: number
		minRetainedBps: number
		expiry: number
	},
	state: {
		tick: number
		lpFee: number
		liquidity: bigint
		tickLower: number
		tickUpper: number
		lastActionAt: number
	},
	outcome:
		| { act: false; reason: string }
		| {
				act: true
				params: { tickLower: number; tickUpper: number; amountIn: bigint; zeroForOne: boolean }
		  },
	now: number,
): string {
	const elapsed = state.lastActionAt === 0 ? 'never moved' : `${now - state.lastActionAt} s ago`
	const facts = [
		`Uniswap v4 pool ${pool.poolId}, LP fee ${state.lpFee} pips. Current tick ${state.tick}.`,
		`The owner's position covers ticks [${state.tickLower}, ${state.tickUpper}) and holds ${state.liquidity} units of liquidity.`,
		`Mandate: range width ${mandate.rangeWidthTicks} ticks, minimum improvement ${mandate.minImprovementBps} bps, cooldown ${mandate.cooldownSeconds} s, retain at least ${mandate.minRetainedBps / 100}%.`,
		`Last move: ${elapsed}.`,
	]
	facts.push(
		outcome.act
			? `Decision: swap ${outcome.params.amountIn} of ${outcome.params.zeroForOne ? 'token0' : 'token1'}, then mint [${outcome.params.tickLower}, ${outcome.params.tickUpper}). Explain to the owner why this happens now.`
			: `Decision: do nothing this run, because ${outcome.reason}. Explain to the owner why nothing happened.`,
	)
	return facts.join(' ')
}
