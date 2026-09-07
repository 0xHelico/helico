import type { Subgraph } from './types'

/** What a caller must supply to reach the network. Never logged, never defaulted. */
export type GraphAuth = {
	/** A Graph Network gateway key. In the enclave this arrives as a secret, not from an env. */
	apiKey: string
}

/**
 * The gateway URL for a published subgraph.
 *
 * A note that cost an hour and is worth keeping: the gateway authenticates **before** it routes,
 * so a request without a key returns
 *
 *     {"errors":[{"message":"auth error: missing authorization header"}]}
 *
 * for a real subgraph id and for a fabricated one alike. That response therefore proves nothing
 * about whether an id exists, and anyone verifying an id with an unauthenticated `curl` has
 * verified only that the gateway is up.
 */
export function gateway(subgraph: Subgraph): string {
	return `https://gateway.thegraph.com/api/subgraphs/id/${subgraph.id}`
}

export type GraphResponse<T> = { data?: T; errors?: { message: string }[] }

/**
 * One POST, and the errors a GraphQL endpoint hides inside a 200.
 *
 * A GraphQL server answers `200 OK` with an `errors` array for a query it refused, so checking
 * the status alone reports success for a response carrying no data. Both are checked here, and
 * the caller gets one thrown error either way.
 *
 * `fetchImpl` is a parameter because the enclave does not have `globalThis.fetch` — it has CRE's
 * HTTP client, which has the same shape. That keeps this file free of any CRE import and lets the
 * browser, the tests and the workflow share it.
 */
export async function query<T>(
	subgraph: Subgraph,
	auth: GraphAuth,
	document: string,
	variables: Record<string, unknown> = {},
	fetchImpl: typeof fetch = fetch,
): Promise<T> {
	if (!auth.apiKey) {
		throw new Error(`No Graph API key for ${subgraph.name}`)
	}
	const res = await fetchImpl(gateway(subgraph), {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${auth.apiKey}`,
		},
		body: JSON.stringify({ query: document, variables }),
	})
	if (!res.ok) {
		// The body can carry the key back in an echoed request; the status is enough to act on.
		throw new Error(`${subgraph.name}: HTTP ${res.status}`)
	}
	const body = (await res.json()) as GraphResponse<T>
	if (body.errors?.length) {
		throw new Error(`${subgraph.name}: ${body.errors.map((e) => e.message).join('; ')}`)
	}
	if (!body.data) {
		throw new Error(`${subgraph.name}: a 200 with no data and no errors`)
	}
	return body.data
}
