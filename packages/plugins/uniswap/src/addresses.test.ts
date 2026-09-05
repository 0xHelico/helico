import { describe, expect, test } from 'bun:test'
import { URVersion } from '@uniswap/v4-sdk'
import { getAddress } from 'viem'
import { addresses, registerV4Addresses, supportedChainIds } from './addresses'
import { robinhood, robinhoodTestnet } from './chains'

const PERMIT2 = getAddress('0x000000000022D473030F116dDEE9F6B43aC78BA3')

describe('addresses', () => {
	test('Base matches the official v4 deployments page and uses router 2.0', () => {
		expect(addresses(8453)).toEqual({
			poolManager: getAddress('0x498581ff718922c3f8e6a244956af099b2652b2b'),
			quoter: getAddress('0x0d5e0f971ed27fbff6c2837bf31316121532048d'),
			stateView: getAddress('0xa3c0c9b65bad0b08107aa264b0f3db444b867a71'),
			positionManager: getAddress('0x7c5f5a4bbd8fd63184577525326123b519429bdc'),
			universalRouter: getAddress('0x6ff5693b99212da76ad316178a184ab56d299b43'),
			universalRouterVersion: URVersion.V2_0,
			permit2: PERMIT2,
		})
	})

	test('Base Sepolia matches the deployments page', () => {
		expect(addresses(84532)).toEqual({
			poolManager: getAddress('0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408'),
			quoter: getAddress('0x4a6513c898fe1b2d0e78d3b0e0a4a151589b1cba'),
			stateView: getAddress('0x571291b572ed32ce6751a2cb2486ebee8defb9b4'),
			positionManager: getAddress('0x4b2c77d209d3405f41a037ec6c77f7f5b8e2ca80'),
			universalRouter: getAddress('0x492e6456d9528771018deb9e87ef7750ef184104'),
			universalRouterVersion: URVersion.V2_0,
			permit2: PERMIT2,
		})
	})

	test('Robinhood Chain matches the deployments page and only has router 2.1.1', () => {
		expect(addresses(robinhood.id)).toEqual({
			poolManager: getAddress('0x8366a39cc670b4001a1121b8f6a443a643e40951'),
			quoter: getAddress('0x8dc178efb8111bb0973dd9d722ebeff267c98f94'),
			stateView: getAddress('0xf3334192d15450cdd385c8b70e03f9a6bd9e673b'),
			positionManager: getAddress('0x58daec3116aae6d93017baaea7749052e8a04fa7'),
			universalRouter: getAddress('0x8876789976decbfcbbbe364623c63652db8c0904'),
			universalRouterVersion: URVersion.V2_1_1,
			permit2: PERMIT2,
		})
	})

	test('Robinhood Chain Testnet comes from the documented deployment with the same core addresses', () => {
		const mainnet = addresses(robinhood.id)
		const testnet = addresses(robinhoodTestnet.id)
		expect(testnet.poolManager).toBe(mainnet.poolManager)
		expect(testnet.quoter).toBe(mainnet.quoter)
		expect(testnet.stateView).toBe(mainnet.stateView)
		expect(testnet.universalRouterVersion).toBe(URVersion.V2_1_1)
	})

	test('Permit2 is the same contract on every chain', () => {
		expect(addresses(1).permit2).toBe(addresses(130).permit2)
	})

	test('throws where v4 is not known', () => {
		expect(() => addresses(999999)).toThrow('not known')
	})

	test('any chain can be registered at runtime and wins over the SDK', () => {
		registerV4Addresses(999998, {
			...addresses(robinhood.id),
			universalRouter: '0x0000000000000000000000000000000000000001',
		})
		expect(addresses(999998).universalRouter).toBe('0x0000000000000000000000000000000000000001')
		expect(supportedChainIds()).toContain(999998)
	})

	test('supportedChainIds lists SDK chains and known deployments, sorted', () => {
		const ids = supportedChainIds()
		for (const id of [1, 8453, 84532, 130, robinhood.id, robinhoodTestnet.id])
			expect(ids).toContain(id)
		expect(ids).toEqual([...ids].sort((a, b) => a - b))
		for (const id of ids) expect(() => addresses(id)).not.toThrow()
	})
})
