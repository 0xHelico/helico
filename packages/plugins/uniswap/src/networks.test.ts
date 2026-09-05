import { describe, expect, test } from 'bun:test'
import { isAddress } from 'viem'
import { addresses } from './addresses'
import { network, networkByChainId, networkKeys, registerNetwork } from './networks'

describe('networks', () => {
	test('ships the well-known chains and every one resolves v4 addresses', () => {
		for (const key of [
			'ethereum',
			'arbitrum',
			'polygon',
			'bnb',
			'base',
			'base-sepolia',
			'robinhood',
			'robinhood-testnet',
		]) {
			const n = network(key)
			expect(n.key).toBe(key)
			expect(isAddress(n.wrappedNative)).toBe(true)
			expect(() => addresses(n.chain.id)).not.toThrow()
			expect(n.explorerTx('0xabc')).toContain('0xabc')
		}
	})

	test('a reference pool is always a native pool against the network stablecoin', () => {
		for (const key of networkKeys()) {
			const n = network(key)
			if (!n.nativeUsdPool || !n.usd) {
				expect(n.nativeUsdPool).toBeUndefined()
				continue
			}
			expect(n.nativeUsdPool.currency0).toBe('0x0000000000000000000000000000000000000000')
			expect(n.nativeUsdPool.currency1).toBe(n.usd.address)
		}
	})

	test('unknown keys name the known ones', () => {
		expect(() => network('nope')).toThrow('robinhood')
	})

	test('any chain can be registered, including its v4 deployment', () => {
		const custom = registerNetwork({
			key: 'custom',
			chain: { ...network('base').chain, id: 424242, name: 'Custom' },
			explorerTx: (h) => h,
			wrappedNative: network('base').wrappedNative,
			v4: addresses(8453),
		})
		expect(networkByChainId(424242)?.key).toBe(custom.key)
		expect(addresses(424242).universalRouter).toBe(addresses(8453).universalRouter)
	})
})
