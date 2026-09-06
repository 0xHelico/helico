// biome-ignore-all lint/suspicious/noConsole: this script prints transaction hashes as evidence
/**
 * Proves `planSwap` against a fork, by sending what it produced and reading what moved.
 *
 *   anvil --fork-url https://arb1.arbitrum.io/rpc --port 8545 --silent &
 *   bun run src/plan.e2e.ts
 *
 * The first leg spends native ETH, which needs no approval. The second spends the USDC the
 * first leg bought, which needs both — the token's allowance to Permit2 and Permit2's own
 * allowance to the router. A plan that forgets the second one reverts here rather than in
 * front of a user.
 */
import {
	createPublicClient,
	createWalletClient,
	erc20Abi,
	formatUnits,
	type Hex,
	http,
	keccak256,
	parseEther,
	toHex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrum } from 'viem/chains'
import { NATIVE, planSwap, type SwapPlan } from './plan'

const RPC = process.env.FORK_RPC_URL ?? 'http://127.0.0.1:8545'
/**
 * Not anvil's default account. On an Arbitrum fork that address has code: someone deployed a
 * contract at the well-known test address whose fallback forwards its whole balance away, so
 * the first payment the swap makes to it takes the other 9,999 ETH with it. The swap is fine;
 * the account is not. Anything derived from a seed nobody has used is, and it is checked below.
 */
const KEY = (process.env.FORK_PRIVATE_KEY ?? keccak256(toHex('helico-plan-e2e'))) as Hex
const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'

const account = privateKeyToAccount(KEY)
const transport = http(RPC)
const publicClient = createPublicClient({ chain: arbitrum, transport })
const wallet = createWalletClient({ account, chain: arbitrum, transport })

const usdc = () =>
	publicClient.readContract({
		address: USDC,
		abi: erc20Abi,
		functionName: 'balanceOf',
		args: [account.address],
	})

/** Sends every step in order and returns what the gas cost, so a balance can be read honestly. */
async function send(plan: SwapPlan): Promise<bigint> {
	let gas = 0n
	for (const step of plan.steps) {
		const hash = await wallet.sendTransaction({ ...step.transaction })
		const receipt = await publicClient.waitForTransactionReceipt({ hash })
		gas += receipt.gasUsed * receipt.effectiveGasPrice
		console.log(`  ${step.kind.padEnd(16)} ${receipt.status} ${hash}`)
		if (receipt.status !== 'success') throw new Error(`${step.kind} reverted`)
	}
	return gas
}

const chainId = await publicClient.getChainId()
if (chainId !== arbitrum.id) throw new Error(`Expected a fork of Arbitrum One, got ${chainId}`)

const code = await publicClient.getCode({ address: account.address })
if (code && code !== '0x') {
	throw new Error(`${account.address} has code on this chain; a swap paying it can be swept`)
}
await publicClient.request({
	method: 'anvil_setBalance' as never,
	params: [account.address, toHex(parseEther('1'))] as never,
})

console.log(`fork of ${chainId} at block ${await publicClient.getBlockNumber()}`)
console.log(`as ${account.address}, funded with 1 ETH\n`)

console.log('0.1 ETH -> USDC')
const buy = await planSwap(publicClient, {
	account: account.address,
	tokenIn: NATIVE,
	tokenOut: USDC,
	amountIn: 10n ** 17n,
})
console.log(
	`  pool fee ${buy.pool.key.fee}, quote ${formatUnits(buy.amountOut, 6)} USDC, floor ${formatUnits(buy.minAmountOut, 6)}`,
)
const usdcBefore = await usdc()
await send(buy)
const bought = (await usdc()) - usdcBefore
console.log(`  received ${formatUnits(bought, 6)} USDC`)
if (bought < buy.minAmountOut) throw new Error('Received less than the floor the plan encoded')

console.log('\nhalf of it back into ETH')
const sell = await planSwap(publicClient, {
	account: account.address,
	tokenIn: USDC,
	tokenOut: NATIVE,
	amountIn: bought / 2n,
})
console.log(`  steps: ${sell.steps.map((s) => s.kind).join(' -> ')}`)
if (!sell.steps.some((s) => s.kind === 'approve-permit2')) {
	throw new Error('A fresh ERC-20 input must need the Permit2 approval')
}
const ethBefore = await publicClient.getBalance({ address: account.address })
const spent = await usdc()
const gas = await send(sell)
const ethBack = (await publicClient.getBalance({ address: account.address })) - ethBefore + gas
console.log(
	`  spent ${formatUnits(spent - (await usdc()), 6)} USDC, received ${formatUnits(ethBack, 18)} ETH`,
)
if (ethBack < sell.minAmountOut) throw new Error('Received less than the floor the plan encoded')

console.log('\nboth legs filled at or above the floor the plan encoded.')
