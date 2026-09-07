#!/usr/bin/env bun
/**
 * Ask the live subgraph the question Aqua cannot answer about itself, and print what came back.
 *
 * The Graph's qualification asks for live data consumed from a Graph provider, and names
 * Subgraph Studio for subgraphs. A mocked dataset does not qualify — so this hits the real
 * endpoint through the same `@helico/plugin-thegraph` code the app uses, not through `curl`.
 * If it prints numbers, the integration works; if it throws, it does not, and no README
 * sentence can paper over that.
 *
 *     bun scripts/check-subgraph.ts [maker address]
 *
 * `GRAPH_STUDIO_URL` overrides the endpoint. Studio takes no key, so there is nothing else to
 * set and nothing here is a secret.
 */
import { endpoint, HELICO_AQUA, makerMandates } from '../packages/plugins/thegraph/src/index'

// The one maker with mandates on Arbitrum One at the time of writing. Public, on chain, and
// not ours — which is the point: this reads the real Aqua, not a fixture we control.
const DEFAULT_MAKER = '0xf54ec0f6996b46b71b8d0c05f8430d2e8ed9413c'

const subgraph = {
	...HELICO_AQUA[42161],
	url: process.env.GRAPH_STUDIO_URL ?? HELICO_AQUA[42161].url,
}
const maker = process.argv[2] ?? DEFAULT_MAKER

const meta = await fetch(endpoint(subgraph), {
	method: 'POST',
	headers: { 'Content-Type': 'application/json' },
	body: JSON.stringify({ query: '{ _meta { block { number timestamp } hasIndexingErrors } }' }),
}).then(
	(r) =>
		r.json() as Promise<{
			data?: { _meta: { block: { number: number; timestamp: number }; hasIndexingErrors: boolean } }
		}>,
)

const block = meta.data?._meta
console.log(`endpoint  ${endpoint(subgraph)}`)
if (block) {
	// Worth printing rather than assuming: a subgraph still syncing answers every query happily
	// with a partial view of the chain, and the answer looks exactly like a complete one.
	const at = new Date(block.block.timestamp * 1000).toISOString()
	console.log(`indexed   block ${block.block.number} (${at})`)
	console.log(`errors    ${block.hasIndexingErrors}`)
}

const res = await makerMandates(subgraph, maker)
console.log(`\nmaker     ${res.maker}`)
console.log(`mandates  ${res.mandates.length}, of which ${res.active} still active`)

if (res.spendable.size === 0) {
	console.log('\nNothing spendable. Either this maker has no live mandate, or the address was')
	console.log('not one the subgraph knows — an unknown maker returns an empty list, not an error.')
} else {
	console.log('\nstill spendable, summed across active mandates:')
	for (const [token, amount] of res.spendable) console.log(`  ${token}  ${amount}`)
}

console.log('\nper mandate:')
for (const m of res.mandates) {
	const tokens = m.balances.map(
		(b) => `${b.token.slice(0, 10)}…=${b.amount}${b.spendable ? '' : ' (docked)'}`,
	)
	console.log(
		`  ${m.strategyHash.slice(0, 12)}…  app ${m.app.slice(0, 10)}…  ${m.active ? 'active' : 'docked'}  ${m.movementCount} movements`,
	)
	for (const t of tokens) console.log(`      ${t}`)
}
