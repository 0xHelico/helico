// biome-ignore-all lint/suspicious/noConsole: this script exists to print evidence
import { createPublicClient, formatUnits, http, zeroAddress } from 'viem'
import { base } from 'viem/chains'
import { getAllowances } from './approval'
import { createPoolKey, getPoolState, sqrtPriceX96ToPrice } from './pool'
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

// Live, read-only, no key and no wallet. Override the RPC with RPC_URL if the default rate-limits you.
const client = createPublicClient({
	chain: base,
	transport: http(process.env.RPC_URL ?? 'https://base-rpc.publicnode.com'),
})
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
// The WETH contract holds native ETH, which makes it a valid eth_call sender for native-input swaps.
const SENDER = '0x4200000000000000000000000000000000000006'
const poolKey = createPoolKey({
	currencyA: zeroAddress,
	currencyB: USDC,
	fee: 500,
	tickSpacing: 10,
})
const oneEth = 10n ** 18n
const deadline = deadlineFromNow(600)

const simulate = async (label: string, tx: Transaction) => {
	await client.call({ account: SENDER, to: tx.to, data: tx.data, value: tx.value })
	console.log(
		`${label}: accepted by the Universal Router via eth_call (${(tx.data.length - 2) / 2} bytes)`,
	)
}

const state = await getPoolState(client, poolKey)
console.log(`pool ${state.poolId}`)
console.log(
	`tick ${state.tick}, liquidity ${state.liquidity}, price ${sqrtPriceX96ToPrice(state.sqrtPriceX96, 18, 6).toFixed(2)} USDC per ETH`,
)

const exactIn = await quoteExactInputSingle(client, { poolKey, zeroForOne: true, amountIn: oneEth })
console.log(`quote exact-in: 1 ETH -> ${formatUnits(exactIn.amountOut, 6)} USDC`)
await simulate(
	'swap exact-in single',
	encodeSwapExactInSingle({
		chainId: base.id,
		poolKey,
		zeroForOne: true,
		amountIn: oneEth,
		amountOutMinimum: minimumAfterSlippage(exactIn.amountOut, 50),
		deadline,
	}),
)

const wantUsdc = 1000_000000n
const exactOut = await quoteExactOutputSingle(client, {
	poolKey,
	zeroForOne: true,
	amountOut: wantUsdc,
})
console.log(`quote exact-out: 1000 USDC <- ${formatUnits(exactOut.amountIn, 18)} ETH`)
await simulate(
	'swap exact-out single',
	encodeSwapExactOutSingle({
		chainId: base.id,
		poolKey,
		zeroForOne: true,
		amountOut: wantUsdc,
		amountInMaximum: maximumAfterSlippage(exactOut.amountIn, 50),
		deadline,
	}),
)

// A real two-hop route: ETH -> USDC -> USDT, both pools at the 0.05 % tier. A route that ends in
// its own input currency would net its deltas out inside the router, so it is not a valid test.
const USDT = '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2'
const route = buildPath({ currencies: [zeroAddress, USDC, USDT], pools: [poolKey, poolKey] })
const hopIn = await quoteExactInput(client, {
	currencyIn: route.currencyIn,
	path: route.exactInPath,
	amountIn: oneEth / 100n,
})
console.log(
	`quote multi-hop exact-in: 0.01 ETH -> ${formatUnits(hopIn.amountOut, 6)} USDT via USDC`,
)
await simulate(
	'swap multi-hop exact-in',
	encodeSwapExactIn({
		chainId: base.id,
		...route,
		path: route.exactInPath,
		amountIn: oneEth / 100n,
		amountOutMinimum: minimumAfterSlippage(hopIn.amountOut, 50),
		deadline,
	}),
)
const wantUsdt = 10_000000n
const hopOut = await quoteExactOutput(client, {
	currencyOut: route.currencyOut,
	path: route.exactOutPath,
	amountOut: wantUsdt,
})
console.log(
	`quote multi-hop exact-out: 10 USDT <- ${formatUnits(hopOut.amountIn, 18)} ETH via USDC`,
)
await simulate(
	'swap multi-hop exact-out',
	encodeSwapExactOut({
		chainId: base.id,
		...route,
		path: route.exactOutPath,
		amountOut: wantUsdt,
		amountInMaximum: maximumAfterSlippage(hopOut.amountIn, 50),
		deadline,
	}),
)

const allowances = await getAllowances(client, { token: USDC, owner: SENDER })
console.log(
	`allowances read: USDC->Permit2 ${allowances.tokenToPermit2}, Permit2->router ${allowances.permit2ToSpender.amount} (nonce ${allowances.permit2ToSpender.nonce})`,
)
