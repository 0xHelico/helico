// biome-ignore-all lint/suspicious/noConsole: this script prints transaction hashes as evidence
import {
	createPublicClient,
	createWalletClient,
	encodeFunctionData,
	formatEther,
	type Hex,
	http,
	parseAbi,
	parseEther,
	parseEventLogs,
	zeroAddress,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { wethAbi } from './abi/weth'
import { addresses } from './addresses'
import {
	approvalsNeeded,
	encodeApprovePermit2,
	encodeApproveTokenToPermit2,
	getAllowances,
} from './approval'
import {
	encodeCollectFees,
	encodeDecreaseLiquidity,
	encodeIncreaseLiquidity,
	encodeInitializePool,
	encodeMintPosition,
	type PoolSnapshot,
	sqrtPriceX96FromAmounts,
} from './liquidity'
import { network } from './networks'
import { createPoolKey, getPoolState, nearestUsableTick } from './pool'
import { quoteExactInputSingle, quoteExactOutputSingle } from './quote'
import {
	deadlineFromNow,
	encodeSwapExactInSingle,
	encodeSwapExactOutSingle,
	maximumAfterSlippage,
	minimumAfterSlippage,
} from './swap'
import type { Transaction } from './types'

/**
 * End to end on any chain the package knows, with nothing but native ETH: wrap some into WETH,
 * make an ETH/WETH pool of our own if none exists, then run every builder against it.
 * CHAIN picks the network (default Robinhood Chain Testnet). PRIVATE_KEY comes from the
 * environment (bun loads a gitignored .env next to package.json) and is never written anywhere.
 */
const pk = process.env.PRIVATE_KEY
if (!pk?.startsWith('0x'))
	throw new Error('Set PRIVATE_KEY to a test wallet holding native ETH on the chosen chain')
const net = network(process.env.CHAIN ?? 'robinhood-testnet')
const account = privateKeyToAccount(pk as Hex)
const transport = http(process.env.RPC_URL)
const client = createPublicClient({ chain: net.chain, transport })
const wallet = createWalletClient({ account, chain: net.chain, transport })
const chainId = net.chain.id
const a = addresses(chainId)
const WETH = net.weth
const SLIPPAGE_BPS = 100
// Total ETH the run may lock in the pool at once; swaps and gas come on top. Everything is withdrawn at the end.
const budget = parseEther(process.env.E2E_ETH ?? '0.002')

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Builds, sends, and waits. Broadcasting retries with a fresh build because public RPCs sit behind
 * lagging nodes; once a hash exists nothing is rebuilt or resent, only the receipt is polled, so a
 * slow receipt can never turn into a second transaction. Gas gets a 50 % cushion.
 */
const send = async <T extends Transaction>(
	label: string,
	build: () => Promise<T> | T,
	attempts = 4,
) => {
	let tx: T | undefined
	let hash: Hex | undefined
	let attempt = 0
	while (!hash) {
		attempt++
		try {
			tx = await build()
			const gas = await client.estimateGas({ account, to: tx.to, data: tx.data, value: tx.value })
			hash = await wallet.sendTransaction({
				to: tx.to,
				data: tx.data,
				value: tx.value,
				gas: (gas * 3n) / 2n,
			})
		} catch (error) {
			if (attempt >= attempts) throw error
			console.log(`  ${label}: attempt ${attempt} failed before broadcasting, retrying in 5 s`)
			await sleep(5000)
		}
	}
	let receipt: Awaited<ReturnType<typeof client.waitForTransactionReceipt>> | undefined
	let waits = 0
	while (!receipt) {
		waits++
		try {
			receipt = await client.waitForTransactionReceipt({ hash })
		} catch (error) {
			if (waits >= 6) throw error
			await sleep(5000)
		}
	}
	if (receipt.status !== 'success')
		throw new Error(`${label} reverted on-chain: ${net.explorerTx(hash)}`)
	console.log(`${label}\n  ${net.explorerTx(hash)}`)
	return { tx: tx as T, receipt }
}

const balancesAt = async (blockNumber: bigint) => {
	for (let attempt = 1; ; attempt++) {
		try {
			return {
				eth: await client.getBalance({ address: account.address, blockNumber }),
				weth: await client.readContract({
					address: WETH,
					abi: wethAbi,
					functionName: 'balanceOf',
					args: [account.address],
					blockNumber,
				}),
			}
		} catch (error) {
			if (attempt >= 5) throw error
			await sleep(3000)
		}
	}
}

const poolKey = createPoolKey({
	currencyA: zeroAddress,
	currencyB: WETH,
	fee: 500,
	tickSpacing: 10,
})
const snapshot = async (): Promise<PoolSnapshot> => {
	const s = await getPoolState(client, poolKey)
	return {
		poolKey,
		decimals0: 18,
		decimals1: 18,
		sqrtPriceX96: s.sqrtPriceX96,
		liquidity: s.liquidity,
		tick: s.tick,
	}
}

const ensureApprovals = async (spender: Hex, amount: bigint) => {
	const allowances = await getAllowances(client, { token: WETH, owner: account.address, spender })
	const needed = approvalsNeeded(allowances, { amount })
	const who = spender === a.positionManager ? 'PositionManager' : 'UniversalRouter'
	if (needed.token)
		await send('approve WETH -> Permit2', () =>
			encodeApproveTokenToPermit2({ chainId, token: WETH }),
		)
	if (needed.permit2)
		await send(`approve Permit2 -> ${who}`, () =>
			encodeApprovePermit2({ chainId, token: WETH, spender }),
		)
	if (!needed.token && !needed.permit2) console.log(`approvals already in place for ${who}`)
}

console.log(
	`${net.chain.name} (${chainId}), router ${a.universalRouterVersion}, wallet ${account.address}`,
)
const start = await balancesAt(await client.getBlockNumber())
console.log(`balances: ${formatEther(start.eth)} ETH, ${formatEther(start.weth)} WETH`)

// 1. Wrap part of the budget so the run owns an ERC-20 side too.
const wrapAmount = budget / 2n
if (start.weth < wrapAmount) {
	await send(`wrap ${formatEther(wrapAmount - start.weth)} ETH into WETH`, () => ({
		to: WETH,
		data: encodeFunctionData({ abi: wethAbi, functionName: 'deposit' }),
		value: wrapAmount - start.weth,
	}))
}

// 2. The pool: ETH/WETH at 1:1, ours if nobody made it before.
let pool = await snapshot()
if (pool.sqrtPriceX96 === 0n) {
	await send('initialize the ETH/WETH pool at 1:1', () =>
		encodeInitializePool({
			chainId,
			poolKey,
			sqrtPriceX96: sqrtPriceX96FromAmounts({ amount0: 1n, amount1: 1n }),
		}),
	)
	pool = await snapshot()
} else {
	console.log(`pool exists: tick ${pool.tick}, liquidity ${pool.liquidity}`)
}
const range = {
	tickLower: nearestUsableTick(pool.tick - 1000, 10),
	tickUpper: nearestUsableTick(pool.tick + 1000, 10),
}

// 3. Mint, then increase, with Permit2 pulling the WETH side.
await ensureApprovals(a.positionManager, wrapAmount)
const { tx: mint, receipt: mintReceipt } = await send('mint position', async () =>
	encodeMintPosition({
		chainId,
		pool: await snapshot(),
		...range,
		amount0: budget / 4n,
		amount1: budget / 4n,
		recipient: account.address,
		slippageBps: SLIPPAGE_BPS,
		deadline: deadlineFromNow(600),
	}),
)
const minted = parseEventLogs({
	abi: parseAbi([
		'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
	]),
	logs: mintReceipt.logs,
}).find(
	(log) =>
		log.address.toLowerCase() === a.positionManager.toLowerCase() && log.args.from === zeroAddress,
)
if (!minted) throw new Error('no position NFT in the mint receipt')
const tokenId = minted.args.tokenId
console.log(`  position NFT #${tokenId}, liquidity ${mint.liquidity}`)
const { tx: increase } = await send('increase liquidity', async () =>
	encodeIncreaseLiquidity({
		chainId,
		pool: await snapshot(),
		...range,
		tokenId,
		amount0: budget / 20n,
		amount1: budget / 20n,
		slippageBps: SLIPPAGE_BPS,
		deadline: deadlineFromNow(600),
	}),
)
const liquidity = mint.liquidity + increase.liquidity

// 4. Swaps: exact-in and exact-out with native input, then WETH in through the Permit2 allowance.
const swapAmount = budget / 50n
const exactIn = await send(`swap exact-in: ${formatEther(swapAmount)} ETH -> WETH`, async () => {
	const quote = await quoteExactInputSingle(client, {
		poolKey,
		zeroForOne: true,
		amountIn: swapAmount,
	})
	return encodeSwapExactInSingle({
		chainId,
		poolKey,
		zeroForOne: true,
		amountIn: swapAmount,
		amountOutMinimum: minimumAfterSlippage(quote.amountOut, SLIPPAGE_BPS),
		deadline: deadlineFromNow(600),
	})
})
const before = await balancesAt(exactIn.receipt.blockNumber)
const exactOut = await send(
	`swap exact-out: ETH -> exactly ${formatEther(swapAmount)} WETH`,
	async () => {
		const quote = await quoteExactOutputSingle(client, {
			poolKey,
			zeroForOne: true,
			amountOut: swapAmount,
		})
		return encodeSwapExactOutSingle({
			chainId,
			poolKey,
			zeroForOne: true,
			amountOut: swapAmount,
			amountInMaximum: maximumAfterSlippage(quote.amountIn, SLIPPAGE_BPS),
			deadline: deadlineFromNow(600),
		})
	},
)
const after = await balancesAt(exactOut.receipt.blockNumber)
console.log(
	`  received ${formatEther(after.weth - before.weth)} WETH, spent ${formatEther(before.eth - after.eth)} ETH including gas`,
)
await ensureApprovals(a.universalRouter, swapAmount)
await send(
	`swap exact-in: ${formatEther(swapAmount)} WETH -> ETH via the Permit2 allowance`,
	async () => {
		const quote = await quoteExactInputSingle(client, {
			poolKey,
			zeroForOne: false,
			amountIn: swapAmount,
		})
		return encodeSwapExactInSingle({
			chainId,
			poolKey,
			zeroForOne: false,
			amountIn: swapAmount,
			amountOutMinimum: minimumAfterSlippage(quote.amountOut, SLIPPAGE_BPS),
			deadline: deadlineFromNow(600),
		})
	},
)

// 5. Collect, then remove everything and burn the NFT.
await send('collect fees', async () =>
	encodeCollectFees({
		chainId,
		pool: await snapshot(),
		...range,
		tokenId,
		liquidity,
		recipient: account.address,
		slippageBps: SLIPPAGE_BPS,
		deadline: deadlineFromNow(600),
	}),
)
const burn = await send('decrease 100 % and burn the position', async () =>
	encodeDecreaseLiquidity({
		chainId,
		pool: await snapshot(),
		...range,
		tokenId,
		liquidity,
		percentageBps: 10_000,
		burnToken: true,
		slippageBps: SLIPPAGE_BPS,
		deadline: deadlineFromNow(600),
	}),
)
const end = await balancesAt(burn.receipt.blockNumber)
console.log(`balances: ${formatEther(end.eth)} ETH, ${formatEther(end.weth)} WETH`)
console.log(
	`net: ${formatEther(end.eth + end.weth - start.eth - start.weth)} ETH-equivalent (gas and fees included)`,
)
