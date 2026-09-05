// biome-ignore-all lint/suspicious/noConsole: this script exists to print evidence
import { createPublicClient, formatUnits, http, zeroAddress } from 'viem'
import { addresses } from './addresses'
import { getAllowances } from './approval'
import { network, networkKeys } from './networks'
import { getPoolState, sqrtPriceX96ToPrice } from './pool'
import {
	quoteExactInput,
	quoteExactInputSingle,
	quoteExactOutput,
	quoteExactOutputSingle,
} from './quote'
import {
	buildPath,
	deadlineFromNow,
	encodeSwapExactIn,
	encodeSwapExactInSingle,
	encodeSwapExactOut,
	encodeSwapExactOutSingle,
	maximumAfterSlippage,
	minimumAfterSlippage,
} from './swap'
import type { Transaction } from './types'

// Live, read-only, no key and no wallet. CHAIN picks the network (default Robinhood Chain),
// RPC_URL overrides its public endpoint if that one rate-limits you.
const net = network(process.env.CHAIN ?? 'robinhood')
const client = createPublicClient({ chain: net.chain, transport: http(process.env.RPC_URL) })
const chainId = net.chain.id
const a = addresses(chainId)
console.log(
	`${net.chain.name} (${chainId}), router ${a.universalRouterVersion} at ${a.universalRouter}`,
)
if (!net.usd || !net.ethUsdPool) {
	console.log(
		`no reference ETH/usd pool configured for "${net.key}" (known networks: ${networkKeys().join(', ')})`,
	)
	process.exit(0)
}
const { usd, ethUsdPool: poolKey } = net
const oneEth = 10n ** 18n
const deadline = deadlineFromNow(600)

// An address that holds native ETH is a valid eth_call sender; the canonical WETH contract or the
// PoolManager (which custodies every native pool) always does.
const sender = async () => {
	for (const candidate of [net.weth, a.poolManager]) {
		if ((await client.getBalance({ address: candidate })) >= oneEth) return candidate
	}
	throw new Error('no ETH-holding sender found for simulation')
}
const from = await sender()

const simulate = async (label: string, tx: Transaction) => {
	await client.call({ account: from, to: tx.to, data: tx.data, value: tx.value })
	console.log(
		`${label}: accepted by the Universal Router via eth_call (${(tx.data.length - 2) / 2} bytes)`,
	)
}

const state = await getPoolState(client, poolKey)
console.log(
	`pool ETH/${usd.symbol} ${poolKey.fee}/${poolKey.tickSpacing} hooks ${poolKey.hooks}: tick ${state.tick}, liquidity ${state.liquidity}, price ${sqrtPriceX96ToPrice(state.sqrtPriceX96, 18, usd.decimals).toFixed(2)} ${usd.symbol} per ETH`,
)

const exactIn = await quoteExactInputSingle(client, { poolKey, zeroForOne: true, amountIn: oneEth })
console.log(
	`quote exact-in: 1 ETH -> ${formatUnits(exactIn.amountOut, usd.decimals)} ${usd.symbol}`,
)
await simulate(
	'swap exact-in single',
	encodeSwapExactInSingle({
		chainId,
		poolKey,
		zeroForOne: true,
		amountIn: oneEth,
		amountOutMinimum: minimumAfterSlippage(exactIn.amountOut, 50),
		deadline,
	}),
)

const wantUsd = 100n * 10n ** BigInt(usd.decimals)
const exactOut = await quoteExactOutputSingle(client, {
	poolKey,
	zeroForOne: true,
	amountOut: wantUsd,
})
console.log(`quote exact-out: 100 ${usd.symbol} <- ${formatUnits(exactOut.amountIn, 18)} ETH`)
await simulate(
	'swap exact-out single',
	encodeSwapExactOutSingle({
		chainId,
		poolKey,
		zeroForOne: true,
		amountOut: wantUsd,
		amountInMaximum: maximumAfterSlippage(exactOut.amountIn, 50),
		deadline,
	}),
)

if (net.multiHop) {
	const route = buildPath(net.multiHop)
	const hopIn = await quoteExactInput(client, {
		currencyIn: route.currencyIn,
		path: route.exactInPath,
		amountIn: oneEth / 100n,
	})
	console.log(
		`quote multi-hop exact-in: 0.01 ETH -> ${hopIn.amountOut} units of ${route.currencyOut} via ${route.exactInPath.length} hops`,
	)
	await simulate(
		'swap multi-hop exact-in',
		encodeSwapExactIn({
			chainId,
			...route,
			path: route.exactInPath,
			amountIn: oneEth / 100n,
			amountOutMinimum: minimumAfterSlippage(hopIn.amountOut, 50),
			deadline,
		}),
	)
	const hopOut = await quoteExactOutput(client, {
		currencyOut: route.currencyOut,
		path: route.exactOutPath,
		amountOut: hopIn.amountOut / 2n,
	})
	console.log(
		`quote multi-hop exact-out: ${hopIn.amountOut / 2n} units <- ${formatUnits(hopOut.amountIn, 18)} ETH`,
	)
	await simulate(
		'swap multi-hop exact-out',
		encodeSwapExactOut({
			chainId,
			...route,
			path: route.exactOutPath,
			amountOut: hopIn.amountOut / 2n,
			amountInMaximum: maximumAfterSlippage(hopOut.amountIn, 50),
			deadline,
		}),
	)
} else {
	console.log(
		`no multi-hop route configured for "${net.key}"; multi-hop encoding is covered by the tests`,
	)
}

const allowances = await getAllowances(client, { token: usd.address, owner: from })
console.log(
	`allowances read for ${from}: ${usd.symbol}->Permit2 ${allowances.tokenToPermit2}, Permit2->router ${allowances.permit2ToSpender.amount} (nonce ${allowances.permit2ToSpender.nonce})`,
)
console.log(zeroAddress === poolKey.currency0 ? 'done' : 'done (pool has no native side)')
