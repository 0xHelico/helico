import { describe, expect, test } from 'bun:test'
import {
	type Address,
	encodeAbiParameters,
	getAddress,
	type Hex,
	parseAbiParameters,
	toFunctionSelector,
	zeroAddress,
} from 'viem'
import { readAccountState } from './chain'
import { configSchema } from './index'
import { fakeRuntime } from './test/fakeRuntime'

// Aave v3 and USDC on Arbitrum One, verified 8 September 2026.
const AAVE_POOL = '0x794a61358D6845594F94dc1DB02A252b5b4814aD'
const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
const AUSDC = '0x724dc807b04555b71ed48a6896b6F41593b8C637'
const account = getAddress('0x746182d0cccc5cefc69853bb0325c850029388c0')
const agent = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const RATE = 27_514_566_416_591_863_466_760_475n

const config = configSchema.parse({
	schedule: '0 */5 * * * *',
	rpcUrl: 'https://arb1.arbitrum.io/rpc',
	delivery: 'forwarder',
	chainSelectorName: 'ethereum-mainnet-arbitrum-1',
	account: account.toLowerCase(),
	pool: AAVE_POOL.toLowerCase(),
	asset: USDC.toLowerCase(),
	agent: agent.toLowerCase(),
	reportReceiver: zeroAddress,
	policyHash: `0x${'0'.repeat(64)}`,
	gasLimit: '1500000',
	deadlineSeconds: 600,
})

const sel = (sig: string): Hex => toFunctionSelector(sig)
const word = (x: bigint | number | boolean | string): Hex =>
	typeof x === 'string'
		? encodeAbiParameters([{ type: 'address' }], [x as Address])
		: encodeAbiParameters([{ type: 'uint256' }], [BigInt(x)])

const reserveData = (aToken: string, rate: bigint): Hex =>
	encodeAbiParameters(
		parseAbiParameters(
			'(uint256, uint128, uint128, uint128, uint128, uint128, uint40, uint16, address, address, address, address, uint128, uint128, uint128)',
		),
		[
			[
				0n,
				10n ** 27n,
				rate,
				10n ** 27n,
				0n,
				0n,
				1_700_000_000,
				12,
				aToken as Address,
				zeroAddress,
				zeroAddress,
				zeroAddress,
				0n,
				0n,
				0n,
			],
		],
	)

const handlers = (receipt: string) => ({
	[sel('function agent()')]: () => word(agent),
	[sel('function permittedVenue(address)')]: () => word(true),
	[sel('function nonce()')]: () => word(7n),
	[sel('function getReserveAToken(address)')]: () => word(receipt),
	[sel('function getVirtualUnderlyingBalance(address)')]: () => word(29_318_183_885_841n),
	[sel('function UNDERLYING_ASSET_ADDRESS()')]: () => word(USDC),
	[sel('function balanceOf(address)')]: (_: Hex, to: string) =>
		word(to.toLowerCase() === USDC.toLowerCase() ? 1_000_000_000n : 500_000_000n),
	[sel('function getReserveData(address)')]: () => reserveData(AUSDC, RATE),
})

const read = (receipt: string, options: { withNonce?: boolean } = {}) => {
	const fake = fakeRuntime({ config, secrets: {}, now: 1_700_000_000, handlers: handlers(receipt) })
	const state = readAccountState(
		fake.runtime,
		config.rpcUrl,
		{
			account: config.account as Address,
			pool: config.pool as Address,
			asset: config.asset as Address,
		},
		options,
	)
	return { state, ...fake }
}

describe('readAccountState', () => {
	test('reads both sides of the account, the market, and its rate', () => {
		const { state } = read(AUSDC)
		expect(state).toEqual({
			agent: getAddress(agent),
			venuePermitted: true,
			idle: 1_000_000_000n,
			receipt: getAddress(AUSDC),
			receiptAsset: getAddress(USDC),
			supplied: 500_000_000n,
			venueLiquidity: 29_318_183_885_841n,
			supplyRateRay: RATE,
			nonce: undefined,
		})
	})

	/**
	 * The order the contracts insist on: the market says which receipt it issues, and only then
	 * is that receipt asked anything. A forged receipt returns the real pool's address and would
	 * pass the question asked the other way round.
	 */
	test('takes the receipt from the market, then reads it in a second batch', () => {
		const { rpcRequests } = read(AUSDC)
		expect(rpcRequests).toHaveLength(2)
		const to = (batch: number) => rpcRequests[batch]?.map((r) => r.params[0].to.toLowerCase()) ?? []
		expect(to(0)).toEqual(
			[account, account, USDC, AAVE_POOL, AAVE_POOL, AAVE_POOL].map((a) => a.toLowerCase()),
		)
		expect(to(1)).toEqual([AUSDC.toLowerCase(), AUSDC.toLowerCase()])
	})

	test('a market that does not list the asset costs one batch and reports nothing supplied', () => {
		const { state, rpcRequests } = read(zeroAddress)
		expect(rpcRequests).toHaveLength(1)
		expect(state.receipt).toBe(zeroAddress)
		expect(state.receiptAsset).toBe(zeroAddress)
		expect(state.supplied).toBe(0n)
		// The market's own numbers are still read; only the receipt's are missing.
		expect(state.venueLiquidity).toBe(29_318_183_885_841n)
	})

	/**
	 * `HelicoAccount.nonce()` takes no argument, where `HelicoVault.nonces(address)` took the
	 * owner. Encoded with an argument it is a different selector and the call reverts, so the
	 * calldata length is the assertion: four bytes, no words.
	 */
	test('asks for the nonce with no argument, and only when it is going to sign', () => {
		const { state, rpcRequests } = read(AUSDC, { withNonce: true })
		expect(state.nonce).toBe(7n)
		expect(rpcRequests[0]).toHaveLength(7)
		expect(rpcRequests[0]?.[6]?.params[0].data).toBe(toFunctionSelector('function nonce()'))
		expect(read(AUSDC).rpcRequests[0]).toHaveLength(6)
	})
})
