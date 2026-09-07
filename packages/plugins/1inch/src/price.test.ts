import { describe, expect, test } from 'bun:test'
import { keccak256 } from 'viem'

import { ARBITRUM_ONE, aquaAddress, swapVmAddress } from './addresses'
import { overCommitment, shipCall, strategyHash } from './calldata'
import { concentratedRange, ONE, rawPrice, sortPair } from './price'
import { concentratedStrategy } from './strategy'

// Arbitrum One: WETH sorts below USDC.
const ARB_WETH = { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18 } as const
const ARB_USDC = { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 } as const
// Ethereum: USDC sorts below WETH. Same pair, opposite order.
const ETH_USDC = { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 } as const
const ETH_WETH = { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 } as const

describe('which token is the numerator flips between chains', () => {
	test('on Arbitrum One, WETH is the lower address', () => {
		expect(sortPair(ARB_WETH, ARB_USDC).lt.address).toBe(ARB_WETH.address)
	})

	test('on Ethereum, the same pair sorts the other way', () => {
		expect(sortPair(ETH_USDC, ETH_WETH).lt.address).toBe(ETH_USDC.address)
	})

	test('and the argument order given does not decide it', () => {
		expect(sortPair(ARB_USDC, ARB_WETH).lt.address).toBe(sortPair(ARB_WETH, ARB_USDC).lt.address)
	})
})

describe('the raw price, which is a ratio of raw amounts and not of human ones', () => {
	// The bug this pins: passing 2800 * 1e18 quoted at $2,808,428,656,082,635 and returned zero
	// output. It did not revert. USDC has 6 decimals and WETH has 18, so the answer is 1e12
	// smaller than the human number suggests.
	test('ETH at $2,800 on Arbitrum is 2800e6, not 2800e18', () => {
		expect(rawPrice(2800n * ONE, ARB_WETH, ARB_USDC)).toBe(2800n * 10n ** 6n)
	})

	test('the 1e12 that a decimals-blind version would produce is not this number', () => {
		expect(rawPrice(2800n * ONE, ARB_WETH, ARB_USDC)).not.toBe(2800n * ONE)
	})

	// Same pair, same price, opposite address order — so the ratio is the reciprocal.
	test('on Ethereum the same $3,000 inverts', () => {
		const raw = rawPrice(3000n * ONE, ETH_WETH, ETH_USDC)
		expect(raw).toBe((ONE * ONE * 10n ** 18n) / (3000n * ONE * 10n ** 6n))
		expect(raw).toBeGreaterThan(rawPrice(4000n * ONE, ETH_WETH, ETH_USDC))
	})

	test('a higher price of the base is a higher ratio when the base sorts first', () => {
		expect(rawPrice(3200n * ONE, ARB_WETH, ARB_USDC)).toBeGreaterThan(
			rawPrice(2800n * ONE, ARB_WETH, ARB_USDC),
		)
	})

	test('zero and negative prices are refused rather than encoded', () => {
		expect(() => rawPrice(0n, ARB_WETH, ARB_USDC)).toThrow(/positive/)
		expect(() => rawPrice(-1n, ARB_WETH, ARB_USDC)).toThrow(/positive/)
	})
})

describe('a band survives the pair inverting', () => {
	test('min stays below max on Arbitrum', () => {
		const r = concentratedRange(2800n * ONE, 3200n * ONE, ARB_WETH, ARB_USDC)
		expect(r.rawPriceMin).toBeLessThan(r.rawPriceMax)
		expect(r.rawPriceMin).toBe(2800n * 10n ** 6n)
	})

	// The silent one: inverting reverses the band, and the SDK accepts min > max happily —
	// the position simply never quotes what was meant.
	test('and on Ethereum, where the cheap end becomes the high ratio', () => {
		const r = concentratedRange(2800n * ONE, 3200n * ONE, ETH_WETH, ETH_USDC)
		expect(r.rawPriceMin).toBeLessThan(r.rawPriceMax)
		expect(r.rawPriceMax).toBe(rawPrice(2800n * ONE, ETH_WETH, ETH_USDC))
	})

	test('an inverted band is refused at the door', () => {
		expect(() => concentratedRange(3200n * ONE, 2800n * ONE, ARB_WETH, ARB_USDC)).toThrow(/below/)
	})
})

describe('what gets shipped', () => {
	const maker = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const
	const position = {
		base: ARB_WETH,
		quote: ARB_USDC,
		priceMin: 2800n * ONE,
		priceMax: 3200n * ONE,
		feeBps: 30,
		maker,
	}

	// Aqua hashes the bytes it is handed; SwapVM looks the balance up under the order's hash.
	// Ship the bare program and the two disagree, every quote reverts, and the revert names a
	// hash Aqua is holding — which reads as a bug in Aqua rather than in the caller.
	test('the strategy is the encoded order, and its hash is the order hash', () => {
		const { order, strategy } = concentratedStrategy(position)
		expect(strategyHash(strategy)).toBe(keccak256(strategy))
		expect(strategyHash(strategy)).toBe(String(order.hash()) as `0x${string}`)
	})

	test('a different band is a different strategy', () => {
		const a = concentratedStrategy(position)
		const b = concentratedStrategy({ ...position, priceMin: 2900n * ONE, priceMax: 3100n * ONE })
		expect(a.strategy).not.toBe(b.strategy)
	})

	// Aqua refuses to re-ship a hash it has ever seen, so identical rules need a fresh salt.
	test('a salt distinguishes two otherwise identical strategies', () => {
		expect(concentratedStrategy({ ...position, salt: 1n }).strategy).not.toBe(
			concentratedStrategy({ ...position, salt: 2n }).strategy,
		)
	})

	test('ship goes to Aqua and names the SwapVM router as the app', () => {
		const { strategy } = concentratedStrategy(position)
		const call = shipCall(ARBITRUM_ONE, strategy, [ARB_WETH.address], [10n ** 18n])
		expect(call.to).toBe(aquaAddress(ARBITRUM_ONE))
		expect(call.data.toLowerCase()).toContain(swapVmAddress(ARBITRUM_ONE).slice(2))
	})

	test('mismatched tokens and amounts are refused before they reach the chain', () => {
		const { strategy } = concentratedStrategy(position)
		expect(() => shipCall(ARBITRUM_ONE, strategy, [ARB_WETH.address], [1n, 2n])).toThrow(
			/same length/,
		)
	})
})

describe('over-commitment, which is the number to watch and not an error', () => {
	const E = 10n ** 18n

	test('three strategies each claiming the whole wallet is 300%', () => {
		expect(overCommitment([10n * E, 10n * E, 10n * E], 10n * E)).toBe(300)
	})

	test('within the wallet is under 100', () => {
		expect(overCommitment([3n * E, 2n * E], 10n * E)).toBe(50)
	})

	// A double cannot hold these, so the ratio is taken in basis points first.
	test('amounts far beyond 2^53 still divide correctly', () => {
		expect(overCommitment([10n ** 30n], 10n ** 30n)).toBe(100)
	})

	test('an empty wallet with claims against it is infinite, not zero', () => {
		expect(overCommitment([1n], 0n)).toBe(Number.POSITIVE_INFINITY)
		expect(overCommitment([], 0n)).toBe(0)
	})
})

describe('the addresses come from the vendor, not from us', () => {
	test('Aqua on Arbitrum One is the live one, not 0x499943E7', () => {
		expect(aquaAddress(ARBITRUM_ONE)).toBe('0x1111113ccf1426a8e30e2bff5e005d929bf6a90a')
	})

	test('an unsupported chain says so rather than returning undefined', () => {
		expect(() => aquaAddress(1337)).toThrow(/No Aqua deployment/)
		expect(() => swapVmAddress(1337)).toThrow(/No SwapVM router/)
	})
})
