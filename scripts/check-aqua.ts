#!/usr/bin/env bun
/**
 * Open three concentrated Aqua positions on one wallet's money, and show that none of them
 * moved a token.
 *
 * This exists because "shared liquidity" is a phrase until you watch a wallet back three
 * positions at once and stay exactly as full as it started. Everything here goes through
 * `@helico/plugin-1inch` and 1inch's deployed SwapVM. No arithmetic of ours prices anything.
 *
 *     anvil --fork-url https://arb1.arbitrum.io/rpc --port 8549 --silent &
 *     bun scripts/check-aqua.ts
 *
 * A fork, because shipping writes to Aqua. Nothing here needs a key, a deployment, or funds on
 * a real chain. `RPC_URL` overrides the endpoint.
 */
import {
	ARBITRUM_ONE,
	aquaAddress,
	concentratedStrategy,
	ONE,
	overCommitment,
	quoteCall,
	shipCall,
	strategyHash,
	swapVmAddress,
} from '@helico/plugin-1inch'
import {
	createPublicClient,
	createWalletClient,
	decodeAbiParameters,
	encodeAbiParameters,
	http,
	keccak256,
	parseAbi,
	toHex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrum } from 'viem/chains'

const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8549'
const WETH = { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18 } as const
const USDC = { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 } as const
// anvil's first account. Public, and holds nothing anywhere real.
const acct = privateKeyToAccount(
	'0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
)

const pub = createPublicClient({ chain: arbitrum, transport: http(RPC) })
const wal = createWalletClient({ account: acct, chain: arbitrum, transport: http(RPC) })
const erc20 = parseAbi([
	'function balanceOf(address) view returns (uint256)',
	'function approve(address,uint256) returns (bool)',
])
const aqua = parseAbi([
	'function rawBalances(address,address,bytes32,address) view returns (uint248,uint8)',
])

const chainId = await pub.getChainId()
if (chainId !== ARBITRUM_ONE) {
	console.error(`Expected a fork of Arbitrum One (42161), got ${chainId}. Is anvil running?`)
	process.exit(1)
}
console.log(`fork of Arbitrum One at block ${await pub.getBlockNumber()}`)
console.log(`aqua    ${aquaAddress(ARBITRUM_ONE)}`)
console.log(`swapvm  ${swapVmAddress(ARBITRUM_ONE)}   (the app the strategies are shipped to)\n`)

// Balance slots, found by probing: USDC 9, WETH 51. Fork-only, the same trick `deal` uses.
const WETH_HELD = 10n * ONE
const USDC_HELD = 20_000n * 10n ** 6n

/** Where Solidity puts `mapping(address => uint256)` entry `holder` of slot `slot`. */
function mappingSlot(holder: `0x${string}`, slot: number): `0x${string}` {
	return keccak256(
		encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [holder, BigInt(slot)]),
	)
}

const setBalance = (token: `0x${string}`, slot: number, amount: bigint) =>
	pub.request({
		method: 'anvil_setStorageAt' as never,
		params: [token, mappingSlot(acct.address, slot), toHex(amount, { size: 32 })] as never,
	})

await setBalance(USDC.address, 9, USDC_HELD)
await setBalance(WETH.address, 51, WETH_HELD)
for (const t of [USDC.address, WETH.address] as const) {
	const hash = await wal.writeContract({
		address: t,
		abi: erc20,
		functionName: 'approve',
		args: [aquaAddress(ARBITRUM_ONE), 2n ** 256n - 1n],
	})
	await pub.waitForTransactionReceipt({ hash })
}

const held = async () =>
	[
		await pub.readContract({
			address: WETH.address,
			abi: erc20,
			functionName: 'balanceOf',
			args: [acct.address],
		}),
		await pub.readContract({
			address: USDC.address,
			abi: erc20,
			functionName: 'balanceOf',
			args: [acct.address],
		}),
	] as const

const [w0, u0] = await held()
console.log(`wallet before   ${w0} WETH   ${u0} USDC\n`)

const bands: [bigint, bigint, string][] = [
	[2800n * ONE, 3200n * ONE, '$2,800–3,200'],
	[2900n * ONE, 3100n * ONE, '$2,900–3,100'],
	[1000n * ONE, 9000n * ONE, '$1,000–9,000'],
]

const shipped: {
	order: ReturnType<typeof concentratedStrategy>['order']
	label: string
	hash: `0x${string}`
}[] = []

for (const [priceMin, priceMax, label] of bands) {
	const { order, strategy } = concentratedStrategy({
		base: WETH,
		quote: USDC,
		priceMin,
		priceMax,
		feeBps: 30,
		maker: acct.address,
	})
	const call = shipCall(
		ARBITRUM_ONE,
		strategy,
		[WETH.address, USDC.address],
		[WETH_HELD, USDC_HELD],
	)
	const hash = await wal.sendTransaction(call)
	const rec = await pub.waitForTransactionReceipt({ hash })
	const transfers = rec.logs.filter((l) => l.address.toLowerCase() !== aquaAddress(ARBITRUM_ONE))
	console.log(
		`ship ${label.padEnd(14)} ${rec.logs.length} Aqua events, ${transfers.length} token transfers`,
	)
	shipped.push({ order, label, hash: strategyHash(strategy) })
}

const [w1, u1] = await held()
console.log(`\nwallet after    ${w1} WETH   ${u1} USDC`)
console.log(`moved           ${w0 - w1} WETH   ${u0 - u1} USDC`)

const committed: bigint[] = []
for (const s of shipped) {
	const [amount] = await pub.readContract({
		address: aquaAddress(ARBITRUM_ONE),
		abi: aqua,
		functionName: 'rawBalances',
		args: [acct.address, swapVmAddress(ARBITRUM_ONE), s.hash, WETH.address],
	})
	committed.push(amount)
}
console.log(
	`\ncommitted       ${committed.reduce((a, b) => a + b, 0n)} WETH against ${w1} held` +
		`  ·  ${overCommitment(committed, w1)}%`,
)

console.log('\nand every one of them quotes, from the same money:')
for (const s of shipped) {
	const call = quoteCall(ARBITRUM_ONE, s.order, USDC.address, WETH.address, 1_000n * 10n ** 6n)
	const res = await pub.call(call)
	const [amountIn, amountOut] = decodeAbiParameters(
		[{ type: 'uint256' }, { type: 'uint256' }],
		res.data as `0x${string}`,
	)
	const price = Number(amountIn) / 1e6 / (Number(amountOut) / 1e18)
	console.log(
		`  ${s.label.padEnd(14)} 1,000 USDC -> ${(Number(amountOut) / 1e18).toFixed(6)} WETH   @ $${price.toFixed(2)}`,
	)
}
