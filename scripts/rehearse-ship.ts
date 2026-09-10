#!/usr/bin/env bun
import { Order } from '@1inch/swap-vm-sdk'
import { ARBITRUM_ONE, quoteCall, swapVmAddress } from '@helico/plugin-1inch'
/**
 * `ship-maker-position.ts`, run against a fork before it is run against money.
 *
 * The script it exercises spends real funds and has four refusals standing between a mistyped
 * command and a loss. A refusal nobody has watched fire is a comment, so this runs the script
 * **unchanged** — same file, same arguments, only `RPC_URL` pointed at anvil — and makes each one
 * fail on purpose. The wallet is generated here and funded from a whale on the fork, so no key of
 * ours is anywhere near it.
 *
 * The last check is the only honest test that a position is live: it quotes the shipped order off
 * 1inch's deployed SwapVM and holds the price against Chainlink's ETH/USD at the same block. An
 * earlier version read the two returned words as one number, called 6.7e150 WETH a pass, and would
 * have said the same thing about a position priced off by a factor of 1e12 — which is the mistake
 * `price.ts` was written to prevent.
 *
 *     anvil --fork-url $ARBITRUM_RPC_URL --port 8549 --silent &
 *     bun scripts/rehearse-ship.ts
 */
import { $ } from 'bun'
import {
	createPublicClient,
	createWalletClient,
	decodeAbiParameters,
	formatUnits,
	http,
	parseAbi,
	toHex,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { arbitrum } from 'viem/chains'

const RPC = 'http://127.0.0.1:8549'
const pub = createPublicClient({ chain: arbitrum, transport: http(RPC) })
const erc20 = parseAbi([
	'function balanceOf(address) view returns (uint256)',
	'function transfer(address,uint256) returns (bool)',
	'function allowance(address,address) view returns (uint256)',
])
const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' as const
const WETH = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' as const
const USDC_HOLDER = '0x724dc807b04555b71ed48a6896b6F41593b8C637' as const
const WETH_HOLDER = '0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8' as const

let failed = 0
function check(what: string, ok: boolean, detail = '') {
	if (!ok) failed++
	console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? `  — ${detail}` : ''}`)
}
const rpc = (method: string, params: unknown[]) =>
	fetch(RPC, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
	}).then((r) => r.json())

async function fund(token: `0x${string}`, from: `0x${string}`, to: `0x${string}`, value: bigint) {
	await rpc('anvil_impersonateAccount', [from])
	await rpc('anvil_setBalance', [from, toHex(10n ** 18n)])
	const w = createWalletClient({ account: from, chain: arbitrum, transport: http(RPC) })
	const hash = await w.writeContract({
		abi: erc20,
		address: token,
		args: [to, value],
		functionName: 'transfer',
	})
	await pub.waitForTransactionReceipt({ hash })
	await rpc('anvil_stopImpersonatingAccount', [from])
}

const key = generatePrivateKey()
const maker = privateKeyToAccount(key)
const env = { ...process.env, RPC_URL: RPC, MAKER_KEY: key }
const run = (extra: Record<string, string>) =>
	$`bun scripts/ship-maker-position.ts`
		.env({ ...env, ...extra })
		.nothrow()
		.quiet()

// 1. It refuses without the confirmation, before touching anything.
const noConfirm = await run({ CONFIRM: '' })
check('no CONFIRM refuses', noConfirm.exitCode === 2, noConfirm.stderr.toString().trim())

// 2. It refuses off Arbitrum One. A bare anvil is chain 31337.
const bare = Bun.spawn(['anvil', '--port', '8550', '--silent'])
for (let i = 0; i < 60; i++) {
	try {
		await fetch('http://127.0.0.1:8550', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{"id":1,"jsonrpc":"2.0","method":"eth_chainId","params":[]}',
		})
		break
	} catch {}
	await Bun.sleep(200)
}
const wrongChain = await run({ CONFIRM: 'ship', RPC_URL: 'http://127.0.0.1:8550' })
check('wrong chain refuses', wrongChain.exitCode === 3, wrongChain.stderr.toString().trim())
bare.kill()

// 3. The reserved-key guard fires on set membership. The four real addresses are checked by
//    reading them; what is *tested* is that being in the set stops the run, with this wallet
//    injected into a copy so the assertion can fail.
const src = await Bun.file('scripts/ship-maker-position.ts').text()
const copyPath = './.ship-copy.tmp.ts'
await Bun.write(
	copyPath,
	src.replace("'0x6DCd7485aB17e0CBD0723b8435a35bb8d029439E',", `'${maker.address}',`),
)
const reserved = await $`bun ${copyPath}`
	.env({ ...env, CONFIRM: 'ship' })
	.nothrow()
	.quiet()
check('a reserved address refuses', reserved.exitCode === 3, reserved.stderr.toString().trim())

// 4. An empty wallet stops before it approves anything.
await rpc('anvil_setBalance', [maker.address, toHex(10n ** 18n)])
const broke = await run({ CONFIRM: 'ship' })
const allowanceAfterRefusal = await pub.readContract({
	abi: erc20,
	address: USDC,
	functionName: 'allowance',
	args: [maker.address, '0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a'],
})
check('an unfunded wallet refuses', broke.exitCode === 4)
check(
	'and approves nothing on the way out',
	allowanceAfterRefusal === 0n,
	`${allowanceAfterRefusal}`,
)

// 5. Funded, it ships.
await fund(USDC, USDC_HOLDER, maker.address, 20n * 10n ** 6n)
await fund(WETH, WETH_HOLDER, maker.address, 10n ** 16n)
const before = await Promise.all(
	[USDC, WETH].map((a) =>
		pub.readContract({ abi: erc20, address: a, functionName: 'balanceOf', args: [maker.address] }),
	),
)
const ok = await run({ CONFIRM: 'ship' })
const out = ok.stdout.toString()
check(
	'it ships',
	ok.exitCode === 0,
	ok.stderr.toString().trim() || out.split('\n').find((l) => l.includes('shipped')),
)
const after = await Promise.all(
	[USDC, WETH].map((a) =>
		pub.readContract({ abi: erc20, address: a, functionName: 'balanceOf', args: [maker.address] }),
	),
)
check(
	'ship moved no tokens',
	before[0] === after[0] && before[1] === after[1],
	`${formatUnits(after[0] as bigint, 6)} USDC · ${formatUnits(after[1] as bigint, 18)} WETH`,
)

// 6. The only honest test that a position is live: quote it off the deployed SwapVM.
const bytes = out.match(/0x[0-9a-fA-F]{200,}/)?.[0]
check(
	'it prints the order bytes a taker needs',
	Boolean(bytes),
	bytes ? `${bytes.length} chars` : 'none',
)
if (bytes) {
	const order = Order.decode(bytes)
	const call = quoteCall(ARBITRUM_ONE, order, USDC, WETH, 500_000n)
	const quoted = await pub.call({ to: call.to, data: call.data })
	// Two words, not one. `BigInt(data)` concatenates them and reads 6.7e150 WETH as a pass.
	const [amountIn, amountOut] = decodeAbiParameters(
		[{ type: 'uint256' }, { type: 'uint256' }],
		quoted.data as `0x${string}`,
	)
	const price = Number(amountIn) / 1e6 / (Number(amountOut) / 1e18)
	const [, answer] = await pub.readContract({
		abi: parseAbi([
			'function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)',
		]),
		address: '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612',
		functionName: 'latestRoundData',
	})
	const feed = Number(answer) / 1e8
	check(
		'the shipped position quotes near the feed',
		amountOut > 0n && Math.abs(price - feed) / feed < 0.1,
		`${formatUnits(amountIn, 6)} USDC -> ${formatUnits(amountOut, 18)} WETH @ $${price.toFixed(2)} vs feed $${feed.toFixed(2)}`,
	)
	// The approval is exactly what was shipped, not unlimited.
	const allowed = await pub.readContract({
		abi: erc20,
		address: USDC,
		functionName: 'allowance',
		args: [maker.address, '0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a'],
	})
	check(
		'the approval is the shipped amount, not max',
		allowed === 5n * 10n ** 6n,
		`${formatUnits(allowed as bigint, 6)} USDC`,
	)
	check('it is filed under 1inch SwapVM', out.includes(swapVmAddress(ARBITRUM_ONE)))
}

await Bun.file(copyPath).unlink()
console.log(failed === 0 ? '\nall green' : `\n${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
