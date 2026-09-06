import type { Address, Chain } from 'viem'
import { arbitrum, base, baseSepolia, bsc, mainnet, polygon } from 'viem/chains'
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
	/** The chain's canonical wrapped native token (WETH, WPOL, WBNB), from the chain's own docs. */
	wrappedNative: Address
	/** The stablecoin the read-only smoke quotes against, if the chain has a liquid one. */
	usd?: Token
	/** A hook-less native/usd pool with liquidity that the smoke reads. Only set once verified. */
	nativeUsdPool?: PoolKey
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
const usdc = (address: Address, decimals = 6): Token => ({ address, symbol: 'USDC', decimals })
const nativePool = (usd: Address): PoolKey => ({
	currency0: ZERO,
	currency1: usd,
	fee: 500,
	tickSpacing: 10,
	hooks: ZERO,
})

/**
 * Built-in networks. Wrapped-native and stablecoin addresses are the canonical ones from each
 * chain's documentation; `nativeUsdPool` is present only where a hook-less 0.05 % pool was read
 * with liquidity (2026-09-05, Arbitrum on 2026-09-06). Chains without one still resolve for every library function.
 */
const builtIn: Network[] = [
	{
		key: 'ethereum',
		chain: mainnet,
		explorerTx: explorer(mainnet),
		wrappedNative: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
		usd: usdc('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'),
	},
	{
		key: 'arbitrum',
		chain: arbitrum,
		explorerTx: explorer(arbitrum),
		wrappedNative: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
		usd: usdc('0xaf88d065e77c8cC2239327C5EDb3A432268e5831'),
		// Hook-less ETH/USDC 0.05 %, spacing 10: liquidity read from StateView on 2026-09-06.
		nativeUsdPool: nativePool('0xaf88d065e77c8cC2239327C5EDb3A432268e5831'),
	},
	{
		key: 'polygon',
		chain: polygon,
		explorerTx: explorer(polygon),
		wrappedNative: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
		usd: usdc('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'),
	},
	{
		key: 'bnb',
		chain: bsc,
		explorerTx: explorer(bsc),
		wrappedNative: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
		// Binance-peg USDC has 18 decimals.
		usd: usdc('0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 18),
		nativeUsdPool: nativePool('0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d'),
	},
	{
		key: 'base',
		chain: base,
		explorerTx: explorer(base),
		wrappedNative: '0x4200000000000000000000000000000000000006',
		usd: usdc('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
		nativeUsdPool: nativePool('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
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
		wrappedNative: '0x4200000000000000000000000000000000000006',
		usd: usdc('0x036CbD53842c5426634e7929541eC2318f3dCF7e'),
		nativeUsdPool: nativePool('0x036CbD53842c5426634e7929541eC2318f3dCF7e'),
	},
	{
		key: 'robinhood',
		chain: robinhood,
		explorerTx: explorer(robinhood),
		wrappedNative: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
		// USDG (Global Dollar) is the quote asset of most Robinhood Chain pools.
		usd: { address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', symbol: 'USDG', decimals: 6 },
		// The deepest hook-less ETH/USDG pool found on 2026-09-05 (liquidity 2.2e17 at tick -198246);
		// most other ETH/USDG pools there carry a dynamic-fee hook.
		nativeUsdPool: {
			currency0: ZERO,
			currency1: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
			fee: 87,
			tickSpacing: 1,
			hooks: ZERO,
		},
	},
	{
		key: 'robinhood-testnet',
		chain: robinhoodTestnet,
		explorerTx: explorer(robinhoodTestnet),
		wrappedNative: '0x7943e237c7F95DA44E0301572D358911207852Fa',
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
