#!/usr/bin/env bun
/**
 * Ship one concentrated position to Aqua on Arbitrum One, with real money.
 *
 * `rehearse-maker.ts` proves this whole path on a fork and cannot do it for real: it holds anvil's
 * published keys and funds itself with `anvil_setStorageAt`. This is the same sequence against the
 * live chain, and it is deliberately the smaller half — it **ships and stops**. Filling is a
 * taker's action and belongs to whoever is demonstrating, not to the script that puts money up.
 *
 *     MAKER_KEY=0x… CONFIRM=ship bun scripts/ship-maker-position.ts
 *
 * Three refusals, because this one spends:
 *
 *   1. It will not run off Arbitrum One.
 *   2. It will not run without `CONFIRM=ship`. Reading the plan and agreeing to it are two acts.
 *   3. It will not run on a key this repository already knows. The deployer, agent, relayer and
 *      upgrader have jobs, and a maker position is takeable by anyone at the price it names —
 *      that is not a risk to hand to a key that also administers accounts.
 *
 * What it gives up: an allowance to Aqua for exactly the amounts shipped, and nothing else. Aqua
 * custodies nothing, `ship` moves no tokens, and `dock` ends it.
 */
import {
	ARBITRUM_ONE,
	aquaAddress,
	concentratedStrategy,
	ONE,
	shipCall,
	strategyHash,
	swapVmAddress,
} from '@helico/plugin-1inch'
import { createPublicClient, createWalletClient, formatUnits, http, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrum } from 'viem/chains'

const RPC = process.env.RPC_URL ?? 'https://arb1.arbitrum.io/rpc'
const DOLLARS_A_SIDE = BigInt(process.env.DOLLARS ?? '5')

const WETH = { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18 } as const
const USDC = { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 } as const
const ETH_USD = '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612' as const

/** Keys this repository already uses. A maker position is takeable by anyone at the price it
 *  names, so it does not go on a key that also deploys, signs for the agent, or upgrades. */
const RESERVED = new Set(
	[
		'0x6DCd7485aB17e0CBD0723b8435a35bb8d029439E',
		'0x84C3891a9693c891877aC474a90d17d29075fcAf',
		'0x96575074e509DAB29D56D83060c2438730aC582E',
		'0xaeE1F9d2ce2D2Cb5F71C2C0Ba7b1a6b0b7f56E9C',
	].map((a) => a.toLowerCase()),
)

const erc20 = parseAbi([
	'function balanceOf(address) view returns (uint256)',
	'function approve(address,uint256) returns (bool)',
])
const feed = parseAbi([
	'function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)',
])

const key = process.env.MAKER_KEY
if (!key) {
	console.error('MAKER_KEY is not set. This ships real funds and will not guess a wallet.')
	process.exit(2)
}
if (process.env.CONFIRM !== 'ship') {
	console.error('Set CONFIRM=ship. Reading what this does and agreeing to it are two acts.')
	process.exit(2)
}

const maker = privateKeyToAccount(key as `0x${string}`)
if (RESERVED.has(maker.address.toLowerCase())) {
	console.error(
		`${maker.address} is one of this repository's own keys. A maker position is takeable at ` +
			'the price it names; use a wallet whose only job is this.',
	)
	process.exit(3)
}

const pub = createPublicClient({ chain: arbitrum, transport: http(RPC) })
const wallet = createWalletClient({ account: maker, chain: arbitrum, transport: http(RPC) })

const chainId = await pub.getChainId()
if (chainId !== ARBITRUM_ONE) {
	console.error(`Expected Arbitrum One (42161), got ${chainId}.`)
	process.exit(3)
}

// Sized against the live feed rather than a number written earlier, so both sides are worth the
// same when they go up and the band sits around a price that is true now.
const [, answer] = await pub.readContract({
	abi: feed,
	address: ETH_USD,
	functionName: 'latestRoundData',
})
if (answer <= 0n) {
	console.error('The ETH/USD feed returned a non-positive answer. Refusing to size against it.')
	process.exit(3)
}
const ethUsd = BigInt(answer) * 10n ** 10n
const usdcSide = DOLLARS_A_SIDE * 10n ** 6n
const wethSide = (DOLLARS_A_SIDE * ONE * ONE) / ethUsd

const [heldUsdc, heldWeth] = await Promise.all(
	[USDC.address, WETH.address].map((address) =>
		pub.readContract({ abi: erc20, address, args: [maker.address], functionName: 'balanceOf' }),
	),
)

console.log(`
maker      ${maker.address}
chain      Arbitrum One
ETH/USD    ${formatUnits(ethUsd, 18)}  (Chainlink)

shipping   ${formatUnits(usdcSide, 6)} USDC  ·  ${formatUnits(wethSide, 18)} WETH
holding    ${formatUnits(heldUsdc as bigint, 6)} USDC  ·  ${formatUnits(heldWeth as bigint, 18)} WETH
band       ${formatUnits((ethUsd * 80n) / 100n, 18)} to ${formatUnits((ethUsd * 120n) / 100n, 18)}
`)

if ((heldUsdc as bigint) < usdcSide || (heldWeth as bigint) < wethSide) {
	console.error('The wallet does not hold both sides. Nothing has been sent.')
	process.exit(4)
}

// The allowance is the only thing given up in advance, and it is for exactly what is shipped —
// Aqua's `pull` is bounded by the ledger anyway, so a larger one buys nothing and outlives this.
for (const [address, amount] of [
	[USDC.address, usdcSide],
	[WETH.address, wethSide],
] as const) {
	const hash = await wallet.writeContract({
		abi: erc20,
		address,
		args: [aquaAddress(ARBITRUM_ONE), amount],
		functionName: 'approve',
	})
	await pub.waitForTransactionReceipt({ hash })
	console.log(`  approved ${formatUnits(amount, address === USDC.address ? 6 : 18)} to Aqua`)
}

const { order, strategy } = concentratedStrategy({
	base: WETH,
	quote: USDC,
	priceMin: (ethUsd * 80n) / 100n,
	priceMax: (ethUsd * 120n) / 100n,
	feeBps: 30,
	maker: maker.address,
})
const hash = await wallet.sendTransaction(
	shipCall(ARBITRUM_ONE, strategy, [WETH.address, USDC.address], [wethSide, usdcSide]),
)
const receipt = await pub.waitForTransactionReceipt({ hash })
if (receipt.status !== 'success') {
	console.error(`The ship reverted. ${hash}`)
	process.exit(5)
}

const [afterUsdc, afterWeth] = await Promise.all(
	[USDC.address, WETH.address].map((address) =>
		pub.readContract({ abi: erc20, address, args: [maker.address], functionName: 'balanceOf' }),
	),
)

console.log(`
shipped    ${hash}
app        ${swapVmAddress(ARBITRUM_ONE)}
hash       ${strategyHash(strategy)}
maker      ${order.maker}

The taker needs the order itself, not the hash — SwapVM looks the balance up under the order,
and these are the bytes it decodes. They are public: the Shipped event carries them.

${strategy}

wallet     ${formatUnits(afterUsdc as bigint, 6)} USDC · ${formatUnits(afterWeth as bigint, 18)} WETH
           ${afterUsdc === heldUsdc && afterWeth === heldWeth ? 'unchanged — ship wrote a ledger entry and moved nothing' : 'CHANGED, which ship should never do'}

The index will carry it within a block or two. To end it, dock the same tokens under that hash.
`)
