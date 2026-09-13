#!/usr/bin/env bun
/**
 * What Aqua holds for one Helico account, read from the ledger itself.
 *
 *     bun scripts/aqua-maker.ts 0x6e8968889a69Ec10cE6f99c8c2539FaB24c902D5
 *
 * The question this answers is the one a demo gets asked: "where is the proof that this account
 * is a maker on Aqua, and that the money is not sitting there?" Three readings, side by side:
 *
 *   1. **The index** names the account's active mandates — app, strategy hash, the bytes.
 *   2. **Aqua's own contract** answers `rawBalances(maker, app, hash, token)` for every token the
 *      mandate names: that is the ledger 1inch settles against, and it needs no key.
 *   3. **The wallet** — `balanceOf(account)` for the same tokens — which is where the money
 *      would be if Aqua held it. It does not: the base tokens sit at the floor and the receipts
 *      carry the balance, because the account lent it out and Aqua holds only the permission.
 *
 * With `ONEINCH_API_KEY` set, 1inch's Aqua API is asked as well and its figures compared to the
 * chain's; the key is read from the environment and never printed. Without it the script still
 * answers, from the chain and the index alone.
 */
import { ARBITRUM_ONE, aquaAddress, decodeMandate, mandateHash } from '@helico/plugin-1inch'
import { createPublicClient, erc20Abi, formatUnits, type Hex, http, parseAbi } from 'viem'
import { arbitrum } from 'viem/chains'

const STUDIO = 'https://api.studio.thegraph.com/query/1758877/helico-arbitrum-one/version/latest'
const RPC = process.env.RPC_URL ?? 'https://arb1.arbitrum.io/rpc'
const AQUA_ABI = parseAbi([
	'function rawBalances(address maker, address app, bytes32 strategyHash, address token) view returns (uint248 balance, uint8 tokensCount)',
])

const account = process.argv[2]
if (!account || !/^0x[0-9a-fA-F]{40}$/.test(account)) {
	console.error('usage: bun scripts/aqua-maker.ts <account>')
	process.exit(2)
}

const pub = createPublicClient({ chain: arbitrum, transport: http(RPC, { timeout: 60_000 }) })
const aqua = aquaAddress(ARBITRUM_ONE)

// ─── 1. the account's active mandates, from the index ────────
const res = (await (
	await fetch(STUDIO, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			query:
				'{ mandates(where:{maker:"' +
				account.toLowerCase() +
				'", active:true}, orderBy: shippedAt, orderDirection: desc) { strategyHash strategy app { id } shippedAt shippedTx } }',
		}),
	})
).json()) as {
	data?: {
		mandates?: {
			strategyHash: Hex
			strategy: Hex
			app: { id: string }
			shippedAt: string
			shippedTx: Hex
		}[]
	}
	errors?: unknown
}
if (res.errors) {
	console.error('the index answered with errors:', JSON.stringify(res.errors))
	process.exit(1)
}
const mandates = res.data?.mandates ?? []
console.log(`account   ${account}`)
console.log(`aqua      ${aqua}   (1inch's ledger contract on Arbitrum One)`)
console.log(`mandates  ${mandates.length} active on the index\n`)
if (mandates.length === 0) process.exit(0)

const symbols = new Map<string, { symbol: string; decimals: number }>()
const nameOf = async (token: Hex) => {
	const key = token.toLowerCase()
	const known = symbols.get(key)
	if (known) return known
	const [symbol, decimals] = await Promise.all([
		pub.readContract({ abi: erc20Abi, address: token, functionName: 'symbol' }),
		pub.readContract({ abi: erc20Abi, address: token, functionName: 'decimals' }),
	])
	const entry = { symbol, decimals }
	symbols.set(key, entry)
	return entry
}

type Reading = { token: Hex; symbol: string; decimals: number; ledger: bigint; wallet: bigint }
const readings = new Map<string, Reading[]>()

for (const row of mandates) {
	const m = decodeMandate(row.strategy)
	const hash = mandateHash(m)
	const agrees = hash.toLowerCase() === row.strategyHash.toLowerCase()
	console.log(
		`mandate   ${row.strategyHash}${agrees ? '' : '   ⚠ the bytes on the index do not hash to this'}`,
	)
	console.log(`app       ${row.app.id}`)
	console.log(
		`shipped   ${new Date(Number(row.shippedAt) * 1000).toISOString()} in ${row.shippedTx}\n` +
			`expires   ${new Date(Number(m.expiry) * 1000).toISOString()}`,
	)
	// Every token the mandate names: the two sides and each venue's receipt for each side. Aqua
	// keeps a ledger line per token, and a receipt's line is what a fill may redeem from. A venue
	// that takes one side only names the zero address for the other, which is not a token.
	const zero = '0x0000000000000000000000000000000000000000'
	const tokens = [
		...new Set(
			[m.token0, m.token1, ...m.venues.flatMap((v) => [v.receipt0, v.receipt1])]
				.map((t) => t.toLowerCase())
				.filter((t) => t !== zero),
		),
	] as Hex[]
	const rows: Reading[] = []
	for (const token of tokens) {
		const [{ symbol, decimals }, [ledger], wallet] = await Promise.all([
			nameOf(token),
			pub.readContract({
				abi: AQUA_ABI,
				address: aqua,
				functionName: 'rawBalances',
				args: [account as Hex, row.app.id as Hex, row.strategyHash, token],
			}),
			pub.readContract({
				abi: erc20Abi,
				address: token,
				functionName: 'balanceOf',
				args: [account as Hex],
			}),
		])
		rows.push({ token, symbol, decimals, ledger, wallet })
	}
	readings.set(row.strategyHash.toLowerCase(), rows)
	console.log('')
	console.log("  token     on Aqua's ledger        in the account's wallet")
	for (const r of rows) {
		console.log(
			`  ${r.symbol.padEnd(9)} ${formatUnits(r.ledger, r.decimals).padEnd(24)} ${formatUnits(r.wallet, r.decimals)}`,
		)
	}
	console.log('')
}

console.log(
	"Aqua's ledger says what a fill may take; the wallet says what is actually there. A base token\n" +
		'at its floor with a receipt carrying the balance is money at work in a market, still quotable.\n',
)

// ─── 2. 1inch's own API, if a key is in the environment ────────
const key = process.env.ONEINCH_API_KEY
if (!key) {
	console.log("(set ONEINCH_API_KEY to compare with 1inch's Aqua API as well)")
	process.exit(0)
}
type Opened = {
	chainId: number | string
	maker: string
	app: string
	strategyHash: string
	// The token's address has been seen under both names; the docs are not explicit.
	tokens?: { token?: string; address?: string; balance?: { strategy?: string } }[]
}
const items: Opened[] = []
let cursor: string | undefined
for (let page = 0; page < 40; page++) {
	const url = `https://api.1inch.dev/aqua/v1.0/strategies/opened?limit=500${cursor ? `&cursor=${cursor}` : ''}`
	const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } })
	if (!r.ok) {
		console.log(`1inch's Aqua API answered ${r.status}; the chain reading above stands on its own.`)
		process.exit(0)
	}
	const body = (await r.json()) as { items?: Opened[]; cursor?: string; nextCursor?: string }
	items.push(...(body.items ?? []))
	cursor = body.cursor ?? body.nextCursor
	if (!cursor) break
}
const mine = items.filter(
	(it) => String(it.chainId) === '42161' && it.maker.toLowerCase() === account.toLowerCase(),
)
console.log(
	`1inch's Aqua API lists ${items.length} open strategies; ${mine.length} with this account as maker.`,
)
for (const it of mine) {
	const rows = readings.get(it.strategyHash.toLowerCase())
	if (!rows) {
		console.log(`  ${it.strategyHash}   (not among the index's active mandates)`)
		continue
	}
	let same = 0
	let differ = 0
	for (const t of it.tokens ?? []) {
		const addr = (t.token ?? t.address ?? '').toLowerCase()
		const r = rows.find((x) => x.token.toLowerCase() === addr)
		if (!r) continue
		if (BigInt(t.balance?.strategy ?? '0') === r.ledger) same++
		else differ++
	}
	console.log(
		`  ${it.strategyHash}   ${same} token${same === 1 ? '' : 's'} agree with the chain${differ ? `, ${differ} differ (the API indexes with a delay)` : ''}`,
	)
}
