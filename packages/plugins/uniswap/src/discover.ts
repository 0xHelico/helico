// biome-ignore-all lint/suspicious/noConsole: this script exists to print what it finds
import { createPublicClient, http, parseAbiItem, zeroAddress } from 'viem'
import { addresses } from './addresses'
import { type Network, network, type Token } from './networks'
import { getPoolState, sqrtPriceX96ToPrice } from './pool'
import type { PoolKey } from './types'

/**
 * Finds native/usd v4 pools with liquidity on any registered chain, so `nativeUsdPool` can be
 * filled with evidence instead of guesses. Scans the PoolManager's `Initialize` logs backwards in
 * windows (public RPCs cap log queries), then reads each pool through StateView.
 * CHAIN picks the network, SPAN and WINDOW are block counts, RPC_URL overrides the endpoint.
 */
const net = network(process.env.CHAIN ?? 'robinhood')
const client = createPublicClient({
	chain: net.chain,
	transport: http(process.env.RPC_URL, { timeout: 90_000 }),
})
const { poolManager } = addresses(net.chain.id)
const requireUsd = (n: Network): Token => {
	if (!n.usd)
		throw new Error(`No stablecoin configured for "${n.key}"; add one to networks.ts first`)
	return n.usd
}
const usd = requireUsd(net)
const span = BigInt(process.env.SPAN ?? 3_000_000)
const window = BigInt(process.env.WINDOW ?? 500_000)

const INIT = parseAbiItem(
	'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function initialisedPools(): Promise<PoolKey[]> {
	const latest = await client.getBlockNumber()
	const keys: PoolKey[] = []
	for (let to = latest; to > latest - span && to > 0n; to -= window) {
		const from = to > window ? to - window + 1n : 0n
		const logs = await client
			.getLogs({
				address: poolManager,
				event: INIT,
				args: { currency0: zeroAddress, currency1: usd.address },
				fromBlock: from,
				toBlock: to,
			})
			.catch((error: Error) => {
				console.log(`window ${from}-${to}: ${error.message.split('\n')[0].slice(0, 80)}`)
				return []
			})
		for (const log of logs) {
			keys.push({
				currency0: zeroAddress,
				currency1: usd.address,
				fee: Number(log.args.fee),
				tickSpacing: Number(log.args.tickSpacing),
				hooks: log.args.hooks as `0x${string}`,
			})
		}
		await sleep(100)
	}
	return keys
}

type Found = { key: PoolKey; liquidity: bigint; tick: number; price: number }

async function withLiquidity(keys: PoolKey[]): Promise<Found[]> {
	const found: Found[] = []
	for (const key of keys) {
		const state = await getPoolState(client, key).catch(() => undefined)
		if (state && state.liquidity > 0n) {
			found.push({
				key,
				liquidity: state.liquidity,
				tick: state.tick,
				price: sqrtPriceX96ToPrice(state.sqrtPriceX96, 18, usd.decimals),
			})
		}
		await sleep(50)
	}
	return found.sort((a, b) => (b.liquidity > a.liquidity ? 1 : -1))
}

console.log(
	`${net.chain.name} (${net.chain.id}): native/${usd.symbol} pools initialised in the last ${span} blocks`,
)
const keys = await initialisedPools()
console.log(`${keys.length} initialised, reading liquidity…`)
const found = await withLiquidity(keys)
console.log(
	`${found.length} with liquidity. Hook-less pools are the ones the smoke can use as nativeUsdPool:`,
)
for (const p of found.slice(0, 15)) {
	const hooked = p.key.hooks === zeroAddress ? '' : ' (hooked)'
	console.log(
		`  fee ${p.key.fee} ts ${p.key.tickSpacing} hooks ${p.key.hooks}${hooked}: liquidity ${p.liquidity}, tick ${p.tick}, price ${p.price.toFixed(2)} ${usd.symbol}`,
	)
}
