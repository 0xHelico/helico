#!/usr/bin/env bun
/**
 * Take a `HelicoMandateSwap` position on Arbitrum One from a plain wallet, through `HelicoTaker`.
 *
 * This is the product's sentence as a transaction: the maker's capital is earning in a lending
 * market, and a taker swaps against it anyway — the app redeems exactly the deficit out of the
 * lending position inside the same swap. The receipt shows the redemption, the transfer to the
 * taker, and the taker's payment landing in the maker's account through Aqua.
 *
 *     TAKER_KEY=0x… CONFIRM=take bun scripts/take-mandate.ts --sell WETH --amount 0.0001
 *
 * That is all a taker knows: the side and the amount. Which mandate answers is asked of the
 * index and the contract — every active mandate on our app is quoted and the best output is
 * taken — the same two questions a router asks. `--mandate 0x…` pins one instead.
 * `[--slippage-bps 50]` sets the floor under the quote; `--quote-only` stops after it.
 *
 * What it does, in order, and each step is checked before the next:
 *
 *   1. Refuses off Arbitrum One and without `CONFIRM=take`. Reads the taker's key from the
 *      environment and never prints it.
 *   2. Finds the mandate on the index by its strategy hash, decodes the bytes Aqua holds, and
 *      checks `keccak256` of them is the hash asked for — so the app answers for the position
 *      that exists, not for a struct typed here.
 *   3. Asks the app to quote. The quote applies every rule the swap will, including whether the
 *      output is coverable out of the mandate's venues, so a refusal here costs no gas.
 *   4. Reads the wallet. Selling WETH from a wallet that holds only ether wraps exactly the
 *      amount first (one transaction) rather than failing on a balance of zero.
 *   5. Approves `HelicoTaker` for exactly `amount`, calls `take` with the quote less slippage as
 *      the floor and a five-minute deadline, and reads back what moved: the taker's balances,
 *      the maker's idle side, the venue receipts, and Aqua's ledger for the mandate.
 */
import {
	ARBITRUM_ONE,
	aquaAddress,
	decodeMandate,
	MANDATE_SWAP_ABI,
	mandateHash,
	mandateSwapAddress,
} from '@helico/plugin-1inch'
import {
	createPublicClient,
	createWalletClient,
	decodeEventLog,
	erc20Abi,
	formatEther,
	formatUnits,
	type Hex,
	http,
	parseAbi,
	parseUnits,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrum } from 'viem/chains'

const RPC = process.env.RPC_URL ?? 'https://arb1.arbitrum.io/rpc'
const STUDIO = 'https://api.studio.thegraph.com/query/1758877/helico-arbitrum-one/version/latest'
const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' as const
const WETH = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' as const
/** `HelicoTaker` on Arbitrum One. `docs/deployments.md` has the deploy; `HELICO_TAKER` overrides. */
const HELICO_TAKER = (process.env.HELICO_TAKER ??
	'0x7A52bfD7EF1b4D0345d6e76deD649FC05208DD58') as Hex
/** Enough ether to stay behind for the two transactions this sends. Measured at ~0.00003 ETH. */
const GAS_CUSHION = 100_000_000_000_000n

const takerAbi = parseAbi([
	'function AQUA() view returns (address)',
	'function APP() view returns (address)',
	'function take((address maker,address token0,address token1,uint256 feeBps,uint256 maxOut0,uint256 maxOut1,uint64 expiry,address agent,bytes32 salt,(address pool,address receipt0,address receipt1,uint8 kind)[] venues) mandate, bool zeroForOne, uint256 amountIn, uint256 amountOutMin, uint256 deadline) returns (uint256 amountOut)',
	'event Taken(address indexed taker, bytes32 indexed mandateHash, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)',
])
const wethAbi = parseAbi(['function deposit() payable'])
const aquaAbi = parseAbi([
	'function rawBalances(address maker, address app, bytes32 strategyHash, address token) view returns (uint248 balance, uint8 tokensCount)',
])

// ─── arguments ───────────────────────────────────────────────
const arg = (name: string, def?: string) => {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 ? process.argv[i + 1] : def
}
let hash = arg('mandate')
const sell = (arg('sell') ?? '').toUpperCase()
const amountArg = arg('amount')
const slippageBps = BigInt(arg('slippage-bps', '50') as string)
if ((hash && !/^0x[0-9a-fA-F]{64}$/.test(hash)) || !['WETH', 'USDC'].includes(sell) || !amountArg) {
	console.error(
		'usage: --sell WETH|USDC --amount <human> [--mandate 0x<strategyHash>] [--slippage-bps 50]\n' +
			'Without --mandate, every active mandate on our app is quoted and the best one is taken.',
	)
	process.exit(1)
}
if (process.env.CONFIRM !== 'take') {
	console.error('Set CONFIRM=take. Reading what this does and agreeing to it are two acts.')
	process.exit(1)
}
const key = process.env.TAKER_KEY
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
	console.error(
		'TAKER_KEY must be a 32-byte hex private key. It is read from the environment and never printed.',
	)
	process.exit(1)
}
const taker = privateKeyToAccount(key as Hex)
// A long timeout, because a fork node answers a quote by fetching four venues' state from
// upstream on first touch; mainnet answers in under a second and never waits on this.
const transport = http(RPC, { timeout: 180_000 })
const pub = createPublicClient({ chain: arbitrum, transport })
const wallet = createWalletClient({ account: taker, chain: arbitrum, transport })
if ((await pub.getChainId()) !== ARBITRUM_ONE) {
	console.error('Not Arbitrum One. Stopping.')
	process.exit(1)
}

// ─── 1. the taker contract is the one over our app ──────────
if (
	/^0x0{40}$/.test(HELICO_TAKER) ||
	(await pub.getCode({ address: HELICO_TAKER })) === undefined
) {
	console.error(
		'HELICO_TAKER is unset or has no code. Deploy it first (script/DeployHelicoTaker.s.sol).',
	)
	process.exit(1)
}
const app = mandateSwapAddress(ARBITRUM_ONE)
const [takerApp, takerAqua] = await Promise.all([
	pub.readContract({ abi: takerAbi, address: HELICO_TAKER, functionName: 'APP' }),
	pub.readContract({ abi: takerAbi, address: HELICO_TAKER, functionName: 'AQUA' }),
])
if (
	takerApp.toLowerCase() !== app.toLowerCase() ||
	takerAqua.toLowerCase() !== aquaAddress(ARBITRUM_ONE).toLowerCase()
) {
	console.error(`HelicoTaker answers APP ${takerApp} / AQUA ${takerAqua}, not ours. Stopping.`)
	process.exit(1)
}

// ─── 1b. no hash given: ask the index which mandates quote, take the best ──
//
// A taker does not know a hash and should not have to. What it knows is the pair and the
// amount; which maker's mandate answers best is the index's question and the contract's — the
// same two a router would ask. Every active mandate on our app is read, the ones on this pair
// and not yet expired are quoted through `quoteExactIn`, a mandate that reverts (one side
// empty, `DegenerateReserves`) is a mandate that does not quote, and the best output wins.
const zeroForOne = sell === 'USDC' // token0 is USDC, token1 is WETH on every mandate our app ships
const decIn = zeroForOne ? 6 : 18
const decOut = zeroForOne ? 18 : 6
const symOut = zeroForOne ? 'WETH' : 'USDC'
const amountIn = parseUnits(amountArg as string, decIn)
if (!hash) {
	const all = (await (
		await fetch(STUDIO, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				query:
					'{ mandates(where:{active:true, app:"' +
					app.toLowerCase() +
					'"}, first: 100) { strategyHash strategy maker { id } } }',
			}),
		})
	).json()) as {
		data?: { mandates?: { strategyHash: Hex; strategy: Hex; maker: { id: string } }[] }
	}
	const rows = all.data?.mandates ?? []
	const nowS = BigInt(Math.floor(Date.now() / 1000))
	console.log(`index        ${rows.length} active mandate${rows.length === 1 ? '' : 's'} on ${app}`)
	let best: { hash: Hex; out: bigint } | null = null
	for (const r of rows) {
		const d = decodeMandate(r.strategy)
		if (
			d.token0.toLowerCase() !== USDC.toLowerCase() ||
			d.token1.toLowerCase() !== WETH.toLowerCase()
		)
			continue
		if (d.expiry <= nowS) continue
		let out: bigint | null = null
		try {
			out = (await pub.readContract({
				abi: MANDATE_SWAP_ABI,
				address: app as Hex,
				functionName: 'quoteExactIn',
				args: [d, zeroForOne, amountIn],
			})) as bigint
		} catch {
			out = null // one side empty: this mandate does not quote
		}
		console.log(
			`  ${r.strategyHash.slice(0, 10)}…  maker ${r.maker.id.slice(0, 10)}…  ${out === null ? 'does not quote' : `${formatUnits(out, decOut)} ${symOut}`}`,
		)
		if (out !== null && (!best || out > best.out)) best = { hash: r.strategyHash, out }
	}
	if (!best) {
		console.error('No active mandate quotes this pair right now.')
		process.exit(1)
	}
	hash = best.hash
	console.log(`chosen       ${hash}  (best output)\n`)
}

// ─── 2. the mandate, from the index, hashed back ────────────
if (!hash) throw new Error('unreachable: no mandate')
const res = (await (
	await fetch(STUDIO, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			query:
				'{ mandates(where:{strategyHash:"' +
				hash.toLowerCase() +
				'"}) { strategy active maker { id } } }',
		}),
	})
).json()) as { data?: { mandates?: { strategy: Hex; active: boolean; maker: { id: string } }[] } }
const row = res.data?.mandates?.[0]
if (!row) {
	console.error('The index has no mandate under that hash.')
	process.exit(1)
}
const m = decodeMandate(row.strategy)
if (mandateHash(m).toLowerCase() !== hash.toLowerCase()) {
	console.error('The bytes on the index do not hash to the mandate asked for. Stopping.')
	process.exit(1)
}
const now = BigInt(Math.floor(Date.now() / 1000))
if (m.expiry <= now) {
	console.error(`The mandate expired at ${new Date(Number(m.expiry) * 1000).toISOString()}.`)
	process.exit(1)
}
if (!row.active) {
	console.error('The index says this mandate is no longer active.')
	process.exit(1)
}
const tokenIn = (zeroForOne ? m.token0 : m.token1) as Hex
const tokenOut = (zeroForOne ? m.token1 : m.token0) as Hex
console.log(
	`mandate      ${hash}  maker ${m.maker}  ${row.active ? 'active' : 'inactive'}, expires ${new Date(Number(m.expiry) * 1000).toISOString()}`,
)
console.log(
	`sides        ${formatUnits(m.maxOut0, 6)} USDC / ${formatEther(m.maxOut1)} WETH, ${m.venues.length} venues`,
)

// ─── 3. the quote, with every rule applied ──────────────────
const quoted = (await pub.readContract({
	abi: MANDATE_SWAP_ABI,
	address: app as Hex,
	functionName: 'quoteExactIn',
	args: [m, zeroForOne, amountIn],
})) as bigint
const floor = (quoted * (10_000n - slippageBps)) / 10_000n
console.log(
	`quote        ${amountArg} ${sell} → ${formatUnits(quoted, decOut)} ${symOut}   (floor ${formatUnits(floor, decOut)})`,
)
// A rehearsal stops here: the index was asked, the contract quoted, nothing was spent.
if (process.argv.includes('--quote-only')) {
	console.log('quote only; nothing sent')
	process.exit(0)
}

// ─── 4. the wallet, and a wrap when it holds only ether ─────
const [held, ether] = await Promise.all([
	pub.readContract({
		abi: erc20Abi,
		address: tokenIn,
		functionName: 'balanceOf',
		args: [taker.address],
	}),
	pub.getBalance({ address: taker.address }),
])
console.log(
	`taker        ${taker.address}   ${formatUnits(held, decIn)} ${sell}, ${formatEther(ether)} ETH`,
)
if (held < amountIn) {
	if (sell !== 'WETH' || ether < amountIn - held + GAS_CUSHION) {
		console.error(
			`The wallet holds ${formatUnits(held, decIn)} ${sell}; it needs ${amountArg}. Stopping.`,
		)
		process.exit(1)
	}
	const wrap = amountIn - held
	console.log(`wrapping     ${formatEther(wrap)} ETH → WETH first`)
	const h = await wallet.writeContract({
		abi: wethAbi,
		address: WETH,
		functionName: 'deposit',
		value: wrap,
	})
	const r = await pub.waitForTransactionReceipt({ hash: h })
	if (r.status !== 'success') {
		console.error('The wrap reverted. Nothing else was sent.')
		process.exit(1)
	}
}

// ─── the maker's side, before ───────────────────────────────
const receipts = m.venues
	.flatMap((v) => [v.receipt0, v.receipt1])
	.filter((r) => !/^0x0{40}$/i.test(r)) as Hex[]
const before = {
	makerIdleOut: await pub.readContract({
		abi: erc20Abi,
		address: tokenOut,
		functionName: 'balanceOf',
		args: [m.maker as Hex],
	}),
	makerIn: await pub.readContract({
		abi: erc20Abi,
		address: tokenIn,
		functionName: 'balanceOf',
		args: [m.maker as Hex],
	}),
	receipts: Object.fromEntries(
		await Promise.all(
			receipts.map(
				async (r) =>
					[
						r,
						await pub.readContract({
							abi: erc20Abi,
							address: r,
							functionName: 'balanceOf',
							args: [m.maker as Hex],
						}),
					] as const,
			),
		),
	),
	ledger: (
		await pub.readContract({
			abi: aquaAbi,
			address: aquaAddress(ARBITRUM_ONE) as Hex,
			functionName: 'rawBalances',
			args: [m.maker as Hex, app as Hex, hash as Hex, tokenOut],
		})
	)[0],
}

// ─── 5. approve exactly, take, read back ────────────────────
const approve = await wallet.writeContract({
	abi: erc20Abi,
	address: tokenIn,
	functionName: 'approve',
	args: [HELICO_TAKER, amountIn],
})
if ((await pub.waitForTransactionReceipt({ hash: approve })).status !== 'success') {
	console.error('The approval reverted. Nothing else was sent.')
	process.exit(1)
}
const deadline = now + 300n
const takeHash = await wallet.writeContract({
	abi: takerAbi,
	address: HELICO_TAKER,
	functionName: 'take',
	args: [m, zeroForOne, amountIn, floor, deadline],
})
console.log(`take         ${takeHash}`)
const receipt = await pub.waitForTransactionReceipt({ hash: takeHash })
if (receipt.status !== 'success') {
	console.error('The take reverted. Read it on Arbiscan before doing anything else.')
	process.exit(1)
}
let amountOut = 0n
for (const log of receipt.logs) {
	if (log.address.toLowerCase() !== HELICO_TAKER.toLowerCase()) continue
	try {
		const ev = decodeEventLog({ abi: takerAbi, data: log.data, topics: log.topics })
		if (ev.eventName === 'Taken') amountOut = ev.args.amountOut
	} catch {}
}
const after = {
	takerOut: await pub.readContract({
		abi: erc20Abi,
		address: tokenOut,
		functionName: 'balanceOf',
		args: [taker.address],
	}),
	makerIdleOut: await pub.readContract({
		abi: erc20Abi,
		address: tokenOut,
		functionName: 'balanceOf',
		args: [m.maker as Hex],
	}),
	makerIn: await pub.readContract({
		abi: erc20Abi,
		address: tokenIn,
		functionName: 'balanceOf',
		args: [m.maker as Hex],
	}),
	receipts: Object.fromEntries(
		await Promise.all(
			receipts.map(
				async (r) =>
					[
						r,
						await pub.readContract({
							abi: erc20Abi,
							address: r,
							functionName: 'balanceOf',
							args: [m.maker as Hex],
						}),
					] as const,
			),
		),
	),
	ledger: (
		await pub.readContract({
			abi: aquaAbi,
			address: aquaAddress(ARBITRUM_ONE) as Hex,
			functionName: 'rawBalances',
			args: [m.maker as Hex, app as Hex, hash as Hex, tokenOut],
		})
	)[0],
}
console.log(`\nblock ${receipt.blockNumber}, ${receipt.gasUsed} gas, ${receipt.logs.length} logs`)
console.log(
	`taker received     ${formatUnits(amountOut, decOut)} ${symOut}  (holds ${formatUnits(after.takerOut, decOut)})`,
)
console.log(
	`maker's ${sell.padEnd(5)}       ${formatUnits(before.makerIn, decIn)} → ${formatUnits(after.makerIn, decIn)}   (+${formatUnits(after.makerIn - before.makerIn, decIn)}, the payment through Aqua)`,
)
console.log(
	`maker's idle ${symOut.padEnd(5)}  ${formatUnits(before.makerIdleOut, decOut)} → ${formatUnits(after.makerIdleOut, decOut)}   (spent first)`,
)
for (const r of receipts) {
	const b = before.receipts[r] as bigint
	const a = after.receipts[r] as bigint
	if (a !== b)
		console.log(
			`receipt ${r.slice(0, 10)}…   ${b} → ${a}   (redeemed out of the lending market, inside the swap)`,
		)
}
console.log(
	`Aqua ledger ${symOut.padEnd(5)}   ${formatUnits(before.ledger, decOut)} → ${formatUnits(after.ledger, decOut)}`,
)
