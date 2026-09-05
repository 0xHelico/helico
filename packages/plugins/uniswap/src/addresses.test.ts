import { describe, expect, test } from 'bun:test'
import { getAddress } from 'viem'
import { addresses, supportedChainIds } from './addresses'

describe('addresses', () => {
	test('Base matches the official v4 deployments page, checksummed', () => {
		const docs = {
			poolManager: '0x498581ff718922c3f8e6a244956af099b2652b2b',
			quoter: '0x0d5e0f971ed27fbff6c2837bf31316121532048d',
			stateView: '0xa3c0c9b65bad0b08107aa264b0f3db444b867a71',
			positionManager: '0x7c5f5a4bbd8fd63184577525326123b519429bdc',
			universalRouter: '0x6ff5693b99212da76ad316178a184ab56d299b43',
			permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
		}
		expect(addresses(8453)).toEqual(
			Object.fromEntries(Object.entries(docs).map(([k, v]) => [k, getAddress(v)])),
		)
	})

	test('Permit2 is the same contract on every chain', () => {
		expect(addresses(1).permit2).toBe(addresses(130).permit2)
	})

	test('throws where v4 is not deployed', () => {
		expect(() => addresses(999999)).toThrow('not deployed')
	})

	test('supportedChainIds lists the chains the SDKs know, sorted', () => {
		const ids = supportedChainIds()
		expect(ids).toContain(1)
		expect(ids).toContain(8453)
		expect(ids).toContain(130)
		expect(ids).toEqual([...ids].sort((a, b) => a - b))
		for (const id of ids) expect(() => addresses(id)).not.toThrow()
	})
})
