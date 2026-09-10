#!/usr/bin/env bun
/**
 * The maker position, rehearsed end to end before a real one costs anything.
 *
 * Part 4 of #320 is the only part that spends Ghoza's money: a position on Arbitrum One, five
 * dollars a side, takeable by anyone at the price it names. Parts 1 to 3 are merged and none of
 * them has ever been proven against a real fill, because there is nothing live on Aqua to fill —
 * of eleven valid orders on Arbitrum One, not one prices USDC into WETH. So the only honest way
 * to know the flow works is to be the maker on a fork first.
 *
 * What it proves, in order:
 *
 *   1. Shipping moves no tokens. The wallet is exactly as full afterwards.
 *   2. The position is **findable** — decoded back out of the `Shipped` event and past the hash
 *      gate, which is the path `fillableFor` and `openOrders` take in the app.
 *   3. It quotes.
 *   4. **A different wallet fills it**, with one approval and one transaction, and the WETH
 *      leaves the maker's own wallet.
 *
 * Step 4 is the one that has never happened anywhere — not on a fork, not on a chain.
 *
 *     anvil --fork-url https://arb1.arbitrum.io/rpc --port 8549 --silent &
 *     bun scripts/rehearse-maker.ts
 *
 * **A fresh anvil each time.** The fork keeps state between runs, and Aqua files a strategy by
 * hash: a second run re-ships bytes it has already seen, which is a no-op, and every balance then
 * reads as though nothing happened. `salt` would dodge that; a clean fork is the honest fix.
 *
 * **Tokens come from real holders, not from storage.** `anvil_setStorageAt` writes a number into
 * a balance slot, which tests the arithmetic and skips the token — the same objection CLAUDE.md
 * makes to `vm.deal`. Impersonating a holder and calling `transfer` makes USDC and WETH agree that
 * the money moved.
 */
import {
	ARBITRUM_ONE,
	aquaAddress,
	concentratedStrategy,
	fillApproval,
	fillCall,
	ONE,
	openOrders,
	quoteCall,
	shipCall,
	swapVmAddress,
} from '@helico/plugin-1inch'
import {
	createPublicClient,
	createWalletClient,
	decodeAbiParameters,
	formatUnits,
	http,
	parseAbi,
	parseAbiItem,
	toHex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrum } from 'viem/chains'

const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8549'

const WETH = { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18 } as const
const USDC = { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 } as const
/** Chainlink ETH/USD on Arbitrum One, eight decimals. The same feed the oracle board reads. */
const ETH_USD = '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612' as const
/** Aave v3's own reserves, which is where the deepest balance of each token happens to sit. */
const USDC_HOLDER = '0x724dc807b04555b71ed48a6896b6F41593b8C637' as const
const WETH_HOLDER = '0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8' as const

const SHIPPED = parseAbiItem(
	'event Shipped(address maker, address app, bytes32 strategyHash, bytes strategy)',
)

/** The position Ghoza intends: five dollars a side. Small enough that being taken at our own
 *  price is not a loss worth minding — which is exactly why the rehearsal uses the real size. */
const USDC_SIDE = 5n * 10n ** 6n
const FIVE_DOLLARS = 5n
/** What the taker spends: a tenth of the position, so the quote stays well inside the band. */
const AMOUNT_IN = 500_000n

// anvil's first two accounts. Public, and hold nothing anywhere real.
const maker = privateKeyToAccount(
	'0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
)
const taker = privateKeyToAccount(
	'0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
)

const pub = createPublicClient({ chain: arbitrum, transport: http(RPC) })
const makerWallet = createWalletClient({ account: maker, chain: arbitrum, transport: http(RPC) })
const takerWallet = createWalletClient({ account: taker, chain: arbitrum, transport: http(RPC) })

const erc20 = parseAbi([
	'function balanceOf(address) view returns (uint256)',
	'function transfer(address to, uint256 value) returns (bool)',
	'function approve(address spender, uint256 value) returns (bool)',
	'function allowance(address owner, address spender) view returns (uint256)',
])
const feed = parseAbi([
	'function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)',
])

const failures: string[] = []
function check(name: string, ok: boolean, detail = '') {
	console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
	if (!ok) failures.push(name)
}

const rpc = (method: string, params: unknown[]) =>
	pub.request({ method: method as never, params: params as never })

/** Move a token out of a real holder's balance, so the token itself agrees it happened. */
async function fund(token: `0x${string}`, from: `0x${string}`, to: `0x${string}`, value: bigint) {
	await rpc('anvil_impersonateAccount', [from])
	await rpc('anvil_setBalance', [from, toHex(ONE)])
	const wallet = createWalletClient({ account: from, chain: arbitrum, transport: http(RPC) })
	const hash = await wallet.writeContract({
		abi: erc20,
		address: token,
		args: [to, value],
		functionName: 'transfer',
	})
	await pub.waitForTransactionReceipt({ hash })
	await rpc('anvil_stopImpersonatingAccount', [from])
}

const balances = async (who: `0x${string}`) =>
	Promise.all(
		([USDC.address, WETH.address] as const).map((token) =>
			pub.readContract({ abi: erc20, address: token, args: [who], functionName: 'balanceOf' }),
		),
	)

const chainId = await pub.getChainId()
if (chainId !== ARBITRUM_ONE) {
	console.error(`Expected a fork of Arbitrum One (42161), got ${chainId}. Is anvil running?`)
	process.exit(1)
}

console.log(`fork of Arbitrum One at block ${await pub.getBlockNumber()}`)
console.log(`aqua    ${aquaAddress(ARBITRUM_ONE)}`)
console.log(`swapvm  ${swapVmAddress(ARBITRUM_ONE)}`)
console.log(`maker   ${maker.address}`)
console.log(`taker   ${taker.address}\n`)

// ── the position is sized against the live price, not a number written last week ──

const [, answer] = await pub.readContract({
	abi: feed,
	address: ETH_USD,
	functionName: 'latestRoundData',
})
if (answer <= 0n) throw new Error('ETH/USD feed returned a non-positive answer')
// The feed carries eight decimals; 1e10 lifts it to the 1e18 that `concentratedStrategy` reads.
const ethUsd = BigInt(answer) * 10n ** 10n
const WETH_SIDE = (FIVE_DOLLARS * ONE * ONE) / ethUsd
console.log(
	`ETH/USD ${formatUnits(ethUsd, 18)} from Chainlink, so five dollars of ETH is ` +
		`${formatUnits(WETH_SIDE, 18)} WETH\n`,
)

// ── 1. a wallet holding exactly the position, funded by tokens that really moved ──

await rpc('anvil_setBalance', [maker.address, toHex(ONE)])
await rpc('anvil_setBalance', [taker.address, toHex(ONE)])
await fund(USDC.address, USDC_HOLDER, maker.address, USDC_SIDE)
await fund(WETH.address, WETH_HOLDER, maker.address, WETH_SIDE)
// The taker gets more than the whole position, so a fill is bounded by what the maker committed
// rather than by what the taker happens to be carrying.
await fund(USDC.address, USDC_HOLDER, taker.address, 100n * 10n ** 6n)

const [mU0, mW0] = await balances(maker.address)
check(
	'the maker holds five dollars a side, transferred rather than written',
	mU0 === USDC_SIDE && mW0 === WETH_SIDE,
	`${formatUnits(mU0, 6)} USDC · ${formatUnits(mW0, 18)} WETH`,
)

// Aqua pulls from the maker's own wallet at fill time, so this allowance is the only thing the
// maker gives up in advance. Nothing is custodied.
for (const token of [USDC.address, WETH.address] as const) {
	const hash = await makerWallet.writeContract({
		abi: erc20,
		address: token,
		args: [aquaAddress(ARBITRUM_ONE), 2n ** 256n - 1n],
		functionName: 'approve',
	})
	await pub.waitForTransactionReceipt({ hash })
}

// ── 2. ship, and prove the wallet did not lighten ──

const { order, strategy } = concentratedStrategy({
	base: WETH,
	quote: USDC,
	// A band around the live price. Outside it the position does not quote, and step 4 would then
	// fail for a reason that has nothing to do with what is being tested.
	priceMin: (ethUsd * 80n) / 100n,
	priceMax: (ethUsd * 120n) / 100n,
	feeBps: 30,
	maker: maker.address,
})
const shipHash = await makerWallet.sendTransaction(
	shipCall(ARBITRUM_ONE, strategy, [WETH.address, USDC.address], [WETH_SIDE, USDC_SIDE]),
)
const shipReceipt = await pub.waitForTransactionReceipt({ hash: shipHash })
check('the position ships', shipReceipt.status === 'success')

const [mU1, mW1] = await balances(maker.address)
check(
	'and shipping moved no tokens — it wrote a ledger entry',
	mU1 === mU0 && mW1 === mW0,
	`${shipReceipt.logs.filter((l) => l.address.toLowerCase() !== aquaAddress(ARBITRUM_ONE)).length} token transfers`,
)

// ── 3. an index would find it, and the hash gate would let it through ──

const logs = await pub.getLogs({
	address: aquaAddress(ARBITRUM_ONE),
	event: SHIPPED,
	fromBlock: shipReceipt.blockNumber,
	toBlock: shipReceipt.blockNumber,
})
const found = openOrders(
	logs.map((l) => ({
		strategy: String(l.args.strategy),
		strategyHash: String(l.args.strategyHash),
	})),
)
check(
	'the event carries enough to rebuild the order, and it survives the hash gate',
	found.length === 1,
	`${found.length} of ${logs.length} shipped rows`,
)

// ── 4. quote, then let a stranger take it ──

const quoted = await pub.call(quoteCall(ARBITRUM_ONE, order, USDC.address, WETH.address, AMOUNT_IN))
const [amountIn, amountOut] = decodeAbiParameters(
	[{ type: 'uint256' }, { type: 'uint256' }],
	quoted.data as `0x${string}`,
)
check(
	'it quotes',
	amountOut > 0n,
	`${formatUnits(amountIn, 6)} USDC -> ${formatUnits(amountOut, 18)} WETH ` +
		`@ $${(Number(amountIn) / 1e6 / (Number(amountOut) / 1e18)).toFixed(2)}`,
)

const approveHash = await takerWallet.sendTransaction(
	fillApproval(ARBITRUM_ONE, USDC.address, AMOUNT_IN),
)
await pub.waitForTransactionReceipt({ hash: approveHash })
const allowance = (spender: `0x${string}`) =>
	pub.readContract({
		abi: erc20,
		address: USDC.address,
		args: [taker.address, spender],
		functionName: 'allowance',
	})
// Read back rather than assumed. Everything else in this package talks to Aqua and this one
// approval does not, and getting it backwards costs a revert with nothing useful in it.
const [toRouter, toAqua] = await Promise.all([
	allowance(swapVmAddress(ARBITRUM_ONE)),
	allowance(aquaAddress(ARBITRUM_ONE)),
])
check(
	'the taker approved the router, and gave Aqua nothing',
	toRouter === AMOUNT_IN && toAqua === 0n,
	`router ${toRouter}, aqua ${toAqua}`,
)

const [tU0, tW0] = await balances(taker.address)
const fillHash = await takerWallet.sendTransaction(
	fillCall(
		ARBITRUM_ONE,
		order,
		USDC.address,
		WETH.address,
		AMOUNT_IN,
		// A floor, because the position is takeable by anyone at the price it named and a block can
		// land between the quote and the fill. Ninety-nine percent of what was quoted.
		(amountOut * 99n) / 100n,
	),
)
const fillReceipt = await pub.waitForTransactionReceipt({ hash: fillHash })
check(
	'a plain wallet fills it — no taker contract, one transaction',
	fillReceipt.status === 'success',
	`gas ${fillReceipt.gasUsed}`,
)

const [tU1, tW1] = await balances(taker.address)
const [mU2, mW2] = await balances(maker.address)
check(
	'the taker paid the USDC it named',
	tU0 - tU1 === AMOUNT_IN,
	`${formatUnits(tU0 - tU1, 6)} USDC`,
)
check(
	'and was paid at least the floor',
	tW1 - tW0 >= (amountOut * 99n) / 100n,
	`${formatUnits(tW1 - tW0, 18)} WETH`,
)
check(
	'out of the maker’s own wallet',
	mW1 - mW2 === tW1 - tW0,
	`maker WETH ${formatUnits(mW1, 18)} -> ${formatUnits(mW2, 18)}`,
)
check(
	'and the maker was paid for it',
	mU2 - mU1 === AMOUNT_IN,
	`maker USDC ${formatUnits(mU1, 6)} -> ${formatUnits(mU2, 6)}`,
)

console.log(
	failures.length === 0
		? '\na five-dollar position was shipped from a wallet that stayed full, found through its own\n' +
				'event, quoted, and taken by a stranger. That is the whole of #320 part 4, at the size it\n' +
				'will really be, before any of it is real.'
		: `\n${failures.length} failed: ${failures.join('; ')}`,
)
process.exit(failures.length === 0 ? 0 : 1)
