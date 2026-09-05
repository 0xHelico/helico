// biome-ignore-all lint/suspicious/noConsole: this script prints transaction hashes as evidence
import {
	createPublicClient,
	createWalletClient,
	formatEther,
	formatUnits,
	type Hex,
	http,
	parseAbi,
	parseEventLogs,
	zeroAddress,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import { erc20Abi } from './abi/erc20'
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
	encodeMintPosition,
	type PoolSnapshot,
} from './liquidity'
import { createPoolKey, getPoolState, nearestUsableTick, sqrtPriceX96ToPrice } from './pool'
import { quoteExactInputSingle, quoteExactOutputSingle } from './quote'
import {
	deadlineFromNow,
	encodeSwapExactInSingle,
	encodeSwapExactOutSingle,
	maximumAfterSlippage,
	minimumAfterSlippage,
} from './swap'
import type { Transaction } from './types'

// End to end on Base Sepolia with a funded test wallet. PRIVATE_KEY comes from the environment
// (bun loads a gitignored .env next to package.json); it is never written anywhere by this script.
const pk = process.env.PRIVATE_KEY
if (!pk?.startsWith('0x'))
	throw new Error('Set PRIVATE_KEY to a Base Sepolia test wallet holding ETH and Circle test USDC')
const account = privateKeyToAccount(pk as Hex)
const rpc = process.env.RPC_URL ?? 'https://sepolia.base.org'
const client = createPublicClient({ chain: baseSepolia, transport: http(rpc) })
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(rpc) })
const chainId = baseSepolia.id
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' // Circle test USDC on Base Sepolia
const a = addresses(chainId)
const poolKey = createPoolKey({
	currencyA: zeroAddress,
	currencyB: USDC,
	fee: 500,
	tickSpacing: 10,
})
const SLIPPAGE_BPS = 100
const explorer = 'https://sepolia.basescan.org/tx/'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Builds, sends, and waits. Public testnet RPCs sit behind load balancers whose nodes lag each
 * other by a block or two, so a fresh approval or a fresh quote can be invisible to the node that
 * estimates gas. Each attempt rebuilds the transaction (new quote, new state) before sending.
 */
const send = async <T extends Transaction>(
	label: string,
	build: () => Promise<T> | T,
	attempts = 4,
) => {
	for (let attempt = 1; ; attempt++) {
		try {
			const tx = await build()
			// Position-manager calls touch storage the estimating node may see differently (a collect
			// ran out of gas at 110k with 162k needed), so the estimate gets a 50 % cushion.
			const estimate = await client.estimateGas({
				account,
				to: tx.to,
				data: tx.data,
				value: tx.value,
			})
			const hash = await wallet.sendTransaction({
				to: tx.to,
				data: tx.data,
				value: tx.value,
				gas: (estimate * 3n) / 2n,
			})
			const receipt = await client.waitForTransactionReceipt({ hash })
			if (receipt.status !== 'success')
				throw new Error(`${label} reverted on-chain: ${explorer}${hash}`)
			console.log(`${label}\n  ${explorer}${hash}`)
			return { tx, receipt }
		} catch (error) {
			if (attempt >= attempts || String(error).includes('reverted on-chain')) throw error
			console.log(`  ${label}: attempt ${attempt} failed before sending, retrying in 5 s`)
			await sleep(5000)
		}
	}
}

/** Balances pinned to a block, retried until the answering node has that block. */
const balancesAt = async (blockNumber: bigint) => {
	for (let attempt = 1; ; attempt++) {
		try {
			return {
				eth: await client.getBalance({ address: account.address, blockNumber }),
				usdc: await client.readContract({
					address: USDC,
					abi: erc20Abi,
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

const snapshot = async (): Promise<PoolSnapshot> => {
	const s = await getPoolState(client, poolKey)
	return {
		poolKey,
		decimals0: 18,
		decimals1: 6,
		sqrtPriceX96: s.sqrtPriceX96,
		liquidity: s.liquidity,
		tick: s.tick,
	}
}

const ensureApprovals = async (spender: Hex, amount: bigint) => {
	const allowances = await getAllowances(client, { token: USDC, owner: account.address, spender })
	const needed = approvalsNeeded(allowances, { amount })
	const who = spender === a.positionManager ? 'PositionManager' : 'UniversalRouter'
	if (needed.token)
		await send('approve USDC -> Permit2', () =>
			encodeApproveTokenToPermit2({ chainId, token: USDC }),
		)
	if (needed.permit2)
		await send(`approve Permit2 -> ${who}`, () =>
			encodeApprovePermit2({ chainId, token: USDC, spender }),
		)
	if (!needed.token && !needed.permit2) console.log(`approvals already in place for ${who}`)
}

console.log(`wallet ${account.address} on Base Sepolia`)
const start = await balancesAt(await client.getBlockNumber())
console.log(`balances: ${formatEther(start.eth)} ETH, ${formatUnits(start.usdc, 6)} USDC`)
const pool = await snapshot()
console.log(
	`pool ETH/USDC ${poolKey.fee}/${poolKey.tickSpacing}: tick ${pool.tick}, liquidity ${pool.liquidity}, price ${sqrtPriceX96ToPrice(pool.sqrtPriceX96, 18, 6).toFixed(2)} USDC per ETH`,
)

// 1. Let Permit2 pull USDC for the PositionManager, then add liquidity around the current price.
await ensureApprovals(a.positionManager, 10_000_000n)
const range = {
	tickLower: nearestUsableTick(pool.tick - 2000, 10),
	tickUpper: nearestUsableTick(pool.tick + 2000, 10),
}
const { tx: mint, receipt: mintReceipt } = await send('mint position', async () =>
	encodeMintPosition({
		chainId,
		pool: await snapshot(),
		...range,
		amount0: 3n * 10n ** 15n,
		amount1: 9_000_000n,
		recipient: account.address,
		slippageBps: SLIPPAGE_BPS,
		deadline: deadlineFromNow(600),
	}),
)
console.log(`  liquidity ${mint.liquidity}, paid ${formatEther(mint.value)} ETH max`)
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
console.log(`  position NFT #${tokenId}`)

// 2. Exact input with native ETH.
const amountIn = 5n * 10n ** 14n
const exactIn = await send(`swap exact-in: ${formatEther(amountIn)} ETH -> USDC`, async () => {
	const quote = await quoteExactInputSingle(client, { poolKey, zeroForOne: true, amountIn })
	console.log(`  quoted ${formatUnits(quote.amountOut, 6)} USDC`)
	return encodeSwapExactInSingle({
		chainId,
		poolKey,
		zeroForOne: true,
		amountIn,
		amountOutMinimum: minimumAfterSlippage(quote.amountOut, SLIPPAGE_BPS),
		deadline: deadlineFromNow(600),
	})
})

// 3. Exact output with native ETH; the router-level SWEEP returns the unused input.
const wantOut = 500_000n
const before = await balancesAt(exactIn.receipt.blockNumber)
const exactOut = await send(
	`swap exact-out: ETH -> exactly ${formatUnits(wantOut, 6)} USDC`,
	async () => {
		const quote = await quoteExactOutputSingle(client, {
			poolKey,
			zeroForOne: true,
			amountOut: wantOut,
		})
		const maxIn = maximumAfterSlippage(quote.amountIn, SLIPPAGE_BPS)
		console.log(
			`  quoted ${formatEther(quote.amountIn)} ETH, sending at most ${formatEther(maxIn)} ETH`,
		)
		return encodeSwapExactOutSingle({
			chainId,
			poolKey,
			zeroForOne: true,
			amountOut: wantOut,
			amountInMaximum: maxIn,
			deadline: deadlineFromNow(600),
		})
	},
)
const after = await balancesAt(exactOut.receipt.blockNumber)
console.log(
	`  received ${formatUnits(after.usdc - before.usdc, 6)} USDC, spent ${formatEther(before.eth - after.eth)} ETH including gas`,
)

// 4. Exact input with an ERC-20, paid through the Permit2 allowance to the router.
await ensureApprovals(a.universalRouter, 1_000_000n)
const usdcIn = 500_000n
await send(
	`swap exact-in: ${formatUnits(usdcIn, 6)} USDC -> ETH via the Permit2 allowance`,
	async () => {
		const quote = await quoteExactInputSingle(client, {
			poolKey,
			zeroForOne: false,
			amountIn: usdcIn,
		})
		console.log(`  quoted ${formatEther(quote.amountOut)} ETH`)
		return encodeSwapExactInSingle({
			chainId,
			poolKey,
			zeroForOne: false,
			amountIn: usdcIn,
			amountOutMinimum: minimumAfterSlippage(quote.amountOut, SLIPPAGE_BPS),
			deadline: deadlineFromNow(600),
		})
	},
)

// 5. Collect what the position earned, then remove everything and burn the NFT.
await send('collect fees', async () =>
	encodeCollectFees({
		chainId,
		pool: await snapshot(),
		...range,
		tokenId,
		liquidity: mint.liquidity,
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
		liquidity: mint.liquidity,
		percentageBps: 10_000,
		burnToken: true,
		slippageBps: SLIPPAGE_BPS,
		deadline: deadlineFromNow(600),
	}),
)

const end = await balancesAt(burn.receipt.blockNumber)
console.log(`balances: ${formatEther(end.eth)} ETH, ${formatUnits(end.usdc, 6)} USDC`)
console.log(
	`net: ${formatEther(end.eth - start.eth)} ETH, ${formatUnits(end.usdc - start.usdc, 6)} USDC (gas and fees included)`,
)
