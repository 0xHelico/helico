import { describe, expect, it } from 'bun:test'
import { decodeAbiParameters, decodeFunctionData, parseAbi } from 'viem'

import { ARBITRUM_ONE, aquaAddress, mandateSwapAddress } from './addresses'
import { AQUA_ABI } from './calldata'
import {
	encodeMandate,
	mandateHash,
	mandateSetupCalls,
	ReceiptKind,
	type SwapMandate,
} from './mandate'

const ACCOUNT = '0x1111111111111111111111111111111111111111' as const
const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' as const
const WETH = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' as const
const AUSDC = '0x724dc807b04555b71ed48a6896b6F41593b8C637' as const
const AAVE_POOL = '0x794a61358D6845594F94dc1DB02A252b5b4814aD' as const
const APP = mandateSwapAddress(ARBITRUM_ONE)
const ZERO = '0x0000000000000000000000000000000000000000' as const

const mandate = (over: Partial<SwapMandate> = {}): SwapMandate => ({
	maker: ACCOUNT,
	token0: USDC,
	token1: WETH,
	feeBps: 30n,
	maxOut0: 1_000_000000n,
	maxOut1: 10n ** 18n,
	expiry: 2_000_000_000n,
	agent: ZERO,
	salt: `0x${'11'.repeat(32)}`,
	venues: [{ pool: AAVE_POOL, receipt0: AUSDC, receipt1: ZERO, kind: ReceiptKind.Rebasing }],
	...over,
})

describe('encodeMandate', () => {
	// The encoding is the mandate's identity, so the only test worth writing is one that reads the
	// bytes back and checks every field survived. A snapshot of the hex would pass just as happily
	// with two fields transposed.
	it('round-trips every field, in the struct’s own order', () => {
		const m = mandate()
		const [back] = decodeAbiParameters(
			[
				{
					type: 'tuple',
					components: [
						{ name: 'maker', type: 'address' },
						{ name: 'token0', type: 'address' },
						{ name: 'token1', type: 'address' },
						{ name: 'feeBps', type: 'uint256' },
						{ name: 'maxOut0', type: 'uint256' },
						{ name: 'maxOut1', type: 'uint256' },
						{ name: 'expiry', type: 'uint64' },
						{ name: 'agent', type: 'address' },
						{ name: 'salt', type: 'bytes32' },
						{
							name: 'venues',
							type: 'tuple[]',
							components: [
								{ name: 'pool', type: 'address' },
								{ name: 'receipt0', type: 'address' },
								{ name: 'receipt1', type: 'address' },
								{ name: 'kind', type: 'uint8' },
							],
						},
					],
				},
			],
			encodeMandate(m),
		)
		expect(back.maker.toLowerCase()).toBe(m.maker.toLowerCase())
		expect(back.token0.toLowerCase()).toBe(m.token0.toLowerCase())
		expect(back.token1.toLowerCase()).toBe(m.token1.toLowerCase())
		expect(back.feeBps).toBe(m.feeBps)
		expect(back.maxOut0).toBe(m.maxOut0)
		expect(back.maxOut1).toBe(m.maxOut1)
		expect(back.expiry).toBe(m.expiry)
		expect(back.salt).toBe(m.salt)
		expect(back.venues.length).toBe(1)
		expect(back.venues[0]?.pool.toLowerCase()).toBe(AAVE_POOL.toLowerCase())
		expect(back.venues[0]?.kind).toBe(ReceiptKind.Rebasing)
	})

	// Aqua refuses a hash it has ever seen, so the salt is the only way to re-issue the same rules.
	// If it did not reach the bytes, a maker who changed it would ship a duplicate and be refused.
	it('gives two mandates that differ only by salt two different hashes', () => {
		const a = mandateHash(mandate({ salt: `0x${'11'.repeat(32)}` }))
		const b = mandateHash(mandate({ salt: `0x${'22'.repeat(32)}` }))
		expect(a).not.toBe(b)
	})

	// The venue list is what lets a fill come out of the maker's Aave position. A mandate with one
	// and a mandate with none are different mandates, and the hash has to say so.
	it('gives a mandate with no venues a different hash from one with a venue', () => {
		expect(mandateHash(mandate({ venues: [] }))).not.toBe(mandateHash(mandate()))
	})
})

describe('mandateSetupCalls', () => {
	const tokens = [USDC, WETH, AUSDC]
	const amounts = [1_000_000000n, 10n ** 18n, 500_000000n]

	it('approves Aqua for each shipped token, and nothing else', () => {
		const calls = mandateSetupCalls(ARBITRUM_ONE, APP, mandate(), tokens, amounts)
		expect(calls.length).toBe(4)

		const erc20 = parseAbi(['function approve(address spender, uint256 value)'])
		for (const [i, token] of tokens.entries()) {
			const call = calls[i]
			expect(call?.to).toBe(token)
			const { functionName, args } = decodeFunctionData({ abi: erc20, data: call?.data ?? '0x' })
			expect(functionName).toBe('approve')
			// To Aqua, because that is who calls `transferFrom` at fill time. An approval to any
			// Helico contract would be custody of the maker's position.
			expect((args[0] as string).toLowerCase()).toBe(aquaAddress(ARBITRUM_ONE))
			// Exactly what was shipped. An unlimited allowance outlives the mandate and buys
			// nothing, because the ledger bounds the spend anyway.
			expect(args[1]).toBe(amounts[i])
		}
	})

	it('ships to the app it was given, under the bytes the hash is taken from', () => {
		const m = mandate()
		const calls = mandateSetupCalls(ARBITRUM_ONE, APP, m, tokens, amounts)
		const ship = calls[3]
		expect(ship?.to).toBe(aquaAddress(ARBITRUM_ONE))

		const { functionName, args } = decodeFunctionData({ abi: AQUA_ABI, data: ship?.data ?? '0x' })
		expect(functionName).toBe('ship')
		// Not the SwapVM router. Shipping a mandate to 1inch's app files bytes it cannot read, and
		// Aqua validates nothing about the app it is handed.
		expect(args?.[0]).toBe(APP)
		expect(args?.[1]).toBe(encodeMandate(m))
		expect(args?.[2]).toEqual(tokens)
		expect(args?.[3]).toEqual(amounts)
	})

	it('refuses a mandate nothing was shipped for', () => {
		expect(() => mandateSetupCalls(ARBITRUM_ONE, APP, mandate(), [], [])).toThrow('never be filled')
		expect(() => mandateSetupCalls(ARBITRUM_ONE, APP, mandate(), tokens, [1n])).toThrow(
			'same length',
		)
	})
})
