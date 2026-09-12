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

// The busiest maker on the live Aqua — 48 shipped strategies as of block 502,288,683. Public,
// on chain, and not ours, which is the point: this reads the real Aqua, not a fixture we
// control. Dozens of strategies under one wallet (48 at that block, 54 by 12 September) is also the argument for the subgraph
// existing: `_balances` is private and four levels deep, no event parameter is indexed, and
// nothing on chain can list them.
//
// It was 0xf54ec0f6… until #165 — a maker on 0x499943E7…, which has emitted nothing since
// block 451,737,844.
const DEFAULT_MAKER = '0xef9f7f4006fe95afede04f6916e72556a957ebbc'

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

// ── The claim this whole integration rests on, measured rather than asserted ──────────────
//
// "There is no on-chain way to ask which mandates a maker has." Every README in this repository
// says it, and until now the evidence was a reading of Aqua's source. This asks the chain.
//
// `Shipped(address maker, address app, bytes32 strategyHash, bytes strategy)` declares no
// parameter `indexed`, so every log it emits carries exactly one topic — the event signature —
// and `eth_getLogs` has nothing to filter on but that. **If any parameter were indexed, a log
// would carry two topics or more and this section would say so.** That is the point of running
// it: the check fails visibly if the claim is false.
const AQUA = '0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a'
const SHIPPED = '0xdc3622e06fb145651f567d421c9ef261d71d43e3778b761907bc0d70d42e52b0'
const rpc = process.env.ARBITRUM_RPC_URL ?? 'https://arb1.arbitrum.io/rpc'

const call = async (method: string, params: unknown[]) => {
	const r = await fetch(rpc, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
	})
	return (await r.json()) as { result?: unknown; error?: { message?: string } }
}

console.log('\nwhat the chain can answer, asked directly:')
try {
	const head = Number((await call('eth_blockNumber', [])).result)
	const from = `0x${Math.max(0, head - 200_000).toString(16)}`
	const logs = (await call('eth_getLogs', [
		{ address: AQUA, topics: [SHIPPED], fromBlock: from, toBlock: 'latest' },
	])) as { result?: { topics: string[] }[]; error?: { message?: string } }
	if (logs.error || !logs.result) {
		console.log(`  the node refused the range: ${logs.error?.message ?? 'no result'}`)
	} else {
		const topics = logs.result.map((l) => l.topics.length)
		const most = topics.length ? Math.max(...topics) : 0
		console.log(`  Shipped logs in the last 200,000 blocks: ${logs.result.length}`)
		console.log(`  topics per log: ${topics.length ? `${Math.min(...topics)}–${most}` : 'n/a'}`)
		console.log(
			most <= 1
				? '  → only topic0, the signature. No parameter is indexed, so logs cannot be'
				: `  → ${most} topics: a parameter IS indexed, and the claim below is wrong.`,
		)
		if (most <= 1)
			console.log('    filtered by maker, by app or by token. Only by "a Shipped happened".')
	}
} catch (e) {
	console.log(`  could not ask the chain: ${e instanceof Error ? e.message : String(e)}`)
}

const res = await makerMandates(subgraph, maker)
console.log(`\nmaker     ${res.maker}`)
console.log(`mandates  ${res.mandates.length}, of which ${res.active} still active`)

if (res.spendable.size === 0) {
	console.log('\nNothing spendable. Three things look identical from here, so check `indexed`')
	console.log('above before concluding anything:')
	console.log('  - this maker genuinely has no live mandate')
	console.log('  - the subgraph has not indexed far enough to have seen them yet')
	console.log('  - the deployed subgraph still points at the Aqua this maker was never on (#165)')
	console.log('An unknown maker returns an empty list, not an error.')
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
