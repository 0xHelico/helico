import { defineChain } from 'viem'

/**
 * Robinhood Chain, an Arbitrum Orbit L2. viem 2.34 ships no definition for it.
 * Sources: https://docs.robinhood.com/chain/deploy-smart-contracts and
 * https://robinhood.com/us/en/support/articles/robinhood-chain-mainnet/
 */
export const robinhood = defineChain({
	id: 4663,
	name: 'Robinhood Chain',
	nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
	rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
	blockExplorers: { default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' } },
})

export const robinhoodTestnet = defineChain({
	id: 46630,
	name: 'Robinhood Chain Testnet',
	nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
	rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com/rpc'] } },
	blockExplorers: {
		default: { name: 'Explorer', url: 'https://explorer.testnet.chain.robinhood.com' },
	},
	testnet: true,
})
