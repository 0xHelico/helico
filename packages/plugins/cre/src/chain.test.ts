import { describe, expect, test } from 'bun:test'
import { poolIdOf, unpackPositionInfo } from './chain'

describe('unpackPositionInfo', () => {
	test('reads the ticks from the packed word with sign extension, as the vault does', () => {
		// tickUpper = 440 at bits 32..55, tickLower = -560 at bits 8..31, hasSubscriber = 0.
		const packed = (440n << 32n) | ((-560n & 0xffffffn) << 8n)
		expect(unpackPositionInfo(packed)).toEqual({ tickLower: -560, tickUpper: 440 })
		expect(unpackPositionInfo((1_000n << 32n) | (100n << 8n) | 1n)).toEqual({
			tickLower: 100,
			tickUpper: 1_000,
		})
	})
})

describe('poolIdOf', () => {
	test('reproduces the Robinhood testnet ETH/WETH pool id', () => {
		expect(
			poolIdOf({
				currency0: '0x0000000000000000000000000000000000000000',
				currency1: '0x7943e237c7F95DA44E0301572D358911207852Fa',
				fee: 500,
				tickSpacing: 10,
				hooks: '0x0000000000000000000000000000000000000000',
			}),
		).toBe('0xea84630b1ccfd69145b791334c55a7d8be1565910cb6e290c489413c977fd9c5')
	})
})
