import type { Address, Chain } from 'viem'
import { base, baseSepolia } from 'viem/chains'
import { registerV4Addresses, type V4Addresses } from './addresses'
import { robinhood, robinhoodTestnet } from './chains'
import type { PoolKey } from './types'

export type Token = { address: Address; symbol: string; decimals: number }

/**
 * What the scripts (and any app) know about a chain beyond its v4 addresses. Adding a chain is
 * one `registerNetwork` call; the library only needs `addresses(chainId)` to resolve.
 */
export type Network = {
	key: string
	chain: Chain
	explorerTx: (hash: string) => string
	/** The chain's canonical wrapped ETH, from the chain's own docs. */
	weth: Address
	/** The stablecoin the read-only smoke quotes against, if the chain has a liquid one. */
	usd?: Token
	/** A hook-less ETH/usd pool with liquidity that the smoke reads. */
	ethUsdPool?: PoolKey
	/** A route with distinct endpoints for the smoke's multi-hop checks. */
	multiHop?: {
		currencies: Address[]
		pools: { fee: number; tickSpacing: number; hooks?: Address }[]
	}
	/** v4 addresses for chains the SDKs do not list; registered on `registerNetwork`. */
	v4?: V4Addresses
}

const ZERO: Address = '0x0000000000000000000000000000000000000000'
const explorer = (chain: Chain) => (hash: string) =>
	`${chain.blockExplorers?.default.url}/tx/${hash}`
const usdc = (address: Address): Token => ({ address, symbol: 'USDC', decimals: 6 })
const ethPool = (usd: Address): PoolKey => ({
	currency0: ZERO,
	currency1: usd,
	fee: 500,
	tickSpacing: 10,
	hooks: ZERO,
})

const builtIn: Network[] = [
	{
		key: 'base',
		chain: base,
		explorerTx: explorer(base),
		weth: '0x4200000000000000000000000000000000000006',
		usd: usdc('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
		ethUsdPool: ethPool('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
		// ETH -> USDC -> USDT, both at the 0.05 % tier.
		multiHop: {
			currencies: [
				ZERO,
				'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
				'0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
			],
			pools: [
				{ fee: 500, tickSpacing: 10 },
				{ fee: 500, tickSpacing: 10 },
			],
		},
	},
	{
		key: 'base-sepolia',
		chain: baseSepolia,
		explorerTx: explorer(baseSepolia),
		weth: '0x4200000000000000000000000000000000000006',
		usd: usdc('0x036CbD53842c5426634e7929541eC2318f3dCF7e'),
		ethUsdPool: ethPool('0x036CbD53842c5426634e7929541eC2318f3dCF7e'),
	},
	{
		key: 'robinhood',
		chain: robinhood,
		explorerTx: explorer(robinhood),
		weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
		// USDG (Global Dollar) is the quote asset of most Robinhood Chain pools.
		usd: { address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', symbol: 'USDG', decimals: 6 },
	},
	{
		key: 'robinhood-testnet',
		chain: robinhoodTestnet,
		explorerTx: explorer(robinhoodTestnet),
		weth: '0x7943e237c7F95DA44E0301572D358911207852Fa',
	},
]

const registry = new Map<string, Network>()

/** Adds or replaces a network. Any chain works: pass `v4` when the SDKs do not know its deployment. */
export function registerNetwork(network: Network): Network {
	registry.set(network.key, network)
	if (network.v4) registerV4Addresses(network.chain.id, network.v4)
	return network
}

for (const n of builtIn) registerNetwork(n)

export function network(key: string): Network {
	const found = registry.get(key)
	if (!found) throw new Error(`Unknown network "${key}". Known: ${[...registry.keys()].join(', ')}`)
	return found
}

export function networkByChainId(chainId: number): Network | undefined {
	return [...registry.values()].find((n) => n.chain.id === chainId)
}

export const networkKeys = (): string[] => [...registry.keys()]
