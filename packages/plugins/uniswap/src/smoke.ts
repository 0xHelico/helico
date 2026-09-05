// biome-ignore-all lint/suspicious/noConsole: this script exists to print evidence
import { createPublicClient, formatUnits, http, zeroAddress } from 'viem'
import { base } from 'viem/chains'
import { encodeSwapExactInSingle, getPoolState, type PoolKey, quoteExactInputSingle } from './index'

// Live, read-only, no key and no wallet: viem's default Base RPC.
const client = createPublicClient({ chain: base, transport: http() })
const poolKey: PoolKey = {
	currency0: zeroAddress,
	currency1: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
	fee: 500,
	tickSpacing: 10,
	hooks: zeroAddress,
}
const amountIn = 10n ** 18n

const state = await getPoolState(client, poolKey)
console.log(`pool ${state.poolId}`)
console.log(`tick ${state.tick}, liquidity ${state.liquidity}`)

const quote = await quoteExactInputSingle(client, { poolKey, zeroForOne: true, amountIn })
console.log(`1 ETH -> ${formatUnits(quote.amountOut, 6)} USDC (gas estimate ${quote.gasEstimate})`)

const tx = encodeSwapExactInSingle({
	chainId: base.id,
	poolKey,
	zeroForOne: true,
	amountIn,
	amountOutMinimum: (quote.amountOut * 995n) / 1000n,
	deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
})
// eth_call from the WETH contract, which holds native ETH: proves the router accepts the
// calldata without anything being signed or sent.
await client.call({
	account: '0x4200000000000000000000000000000000000006',
	to: tx.to,
	data: tx.data,
	value: tx.value,
})
console.log(
	`swap calldata accepted by the Universal Router ${tx.to} via eth_call, ${(tx.data.length - 2) / 2} bytes`,
)
