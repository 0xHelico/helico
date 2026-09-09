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
/** A second Aave-family market, and the receipt it issues. Only their addresses matter here. */
const OTHER_POOL = `0x${'22'.repeat(20)}`
const OTHER_RECEIPT = `0x${'23'.repeat(20)}`
const account = getAddress('0x746182d0cccc5cefc69853bb0325c850029388c0')
const agent = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const RATE = 27_514_566_416_591_863_466_760_475n
const OTHER_RATE = 41_000_000_000_000_000_000_000_000n // 4.1%

const config = configSchema.parse({
	schedule: '0 */5 * * * *',
	rpcUrl: 'https://arb1.arbitrum.io/rpc',
	delivery: 'forwarder',
	chainSelectorName: 'ethereum-mainnet-arbitrum-1',
	account: account.toLowerCase(),
	pools: [{ address: AAVE_POOL.toLowerCase(), kind: 'rebasing' as const }],
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

/** What each market answers, keyed by the market's own address. */
const market = (receipt: string, rate: bigint, liquidity: bigint) => ({ receipt, rate, liquidity })
type Market = ReturnType<typeof market>

const handlers = (markets: Record<string, Market>) => {
	const at = (to: string): Market => {
		const found = markets[to.toLowerCase()]
		if (!found) throw new Error(`unmodelled market ${to}`)
		return found
	}
	return {
		[sel('function agent()')]: () => word(agent),
		[sel('function permittedVenue(address)')]: () => word(true),
		[sel('function nonce()')]: () => word(7n),
		[sel('function getReserveAToken(address)')]: (_: Hex, to: string) => word(at(to).receipt),
		[sel('function getVirtualUnderlyingBalance(address)')]: (_: Hex, to: string) =>
			word(at(to).liquidity),
		[sel('function UNDERLYING_ASSET_ADDRESS()')]: () => word(USDC),
		[sel('function balanceOf(address)')]: (_: Hex, to: string) => {
			if (to.toLowerCase() === USDC.toLowerCase()) return word(1_000_000_000n)
			return word(to.toLowerCase() === AUSDC.toLowerCase() ? 500_000_000n : 700_000_000n)
		},
		[sel('function getReserveData(address)')]: (_: Hex, to: string) =>
			reserveData(at(to).receipt, at(to).rate),
		// A share-priced receipt, priced deliberately far from par so a conversion that silently
		// does nothing is visible rather than a rounding argument. Four underlying to the share.
		[sel('function previewRedeem(uint256)')]: (data: Hex) =>
			word(BigInt(`0x${data.slice(10)}`) * 4n),
	}
}

const aave = (receipt = AUSDC) => market(receipt, RATE, 29_318_183_885_841n)
const other = market(OTHER_RECEIPT, OTHER_RATE, 4_000_000_000n)

const read = (markets: Record<string, Market>, options: { withNonce?: boolean } = {}) => {
	// Every fixture market here is Aave-shaped, so they are all rebasing. The share-priced path
	// has its own test below, which points a market at a receipt that answers `previewRedeem`.
	const pools = Object.keys(markets).map((address) => ({
		address: address as Address,
		kind: 'rebasing' as const,
	}))
	const fake = fakeRuntime({
		config: configSchema.parse({ ...config, pools }),
		secrets: {},
		now: 1_700_000_000,
		handlers: handlers(markets),
	})
	const state = readAccountState(
		fake.runtime,
		config.rpcUrl,
		{ account: config.account as Address, pools, asset: config.asset as Address },
		options,
	)
	return { state, ...fake }
}

const onlyAave = (receipt = AUSDC) => ({ [AAVE_POOL.toLowerCase()]: aave(receipt) })
const both = {
	[AAVE_POOL.toLowerCase()]: aave(),
	[OTHER_POOL.toLowerCase()]: other,
}

/** Like `read`, but the single market is declared share-priced rather than rebasing. */
const readSharePriced = (markets: Record<string, Market>) => {
	const pools = Object.keys(markets).map((address) => ({
		address: address as Address,
		kind: 'share-priced' as const,
	}))
	const fake = fakeRuntime({
		config: configSchema.parse({ ...config, pools }),
		secrets: {},
		now: 1_700_000_000,
		handlers: handlers(markets),
	})
	const state = readAccountState(
		fake.runtime,
		config.rpcUrl,
		{ account: config.account as Address, pools, asset: config.asset as Address },
		{},
	)
	return { state, ...fake }
}

describe('a share-priced venue', () => {
	test('reports the position in the asset, not the share count', () => {
		const { state } = readSharePriced(onlyAave())
		const venue = state.venues[0]

		// The receipt says 500; a share is worth four, so the position is 2,000. Reading the first
		// number as the second is the bug this exists to stop, and it is the same
		// one-receipt-is-one-underlying assumption `ReceiptMath.sol` removed from the contracts.
		expect(venue?.receiptBalance).toBe(500_000_000n)
		expect(venue?.supplied).toBe(2_000_000_000n)
		expect(venue?.kind).toBe('share-priced')
	})

	test('a rebasing venue is not converted, and costs no extra call', () => {
		const shared = readSharePriced(onlyAave())
		const plain = read(onlyAave())

		expect(plain.state.venues[0]?.supplied).toBe(500_000_000n)
		expect(plain.state.venues[0]?.receiptBalance).toBe(500_000_000n)
		// Two round trips for the rebasing case and three for the share-priced one: the conversion
		// is paid for only where it is needed, so the single-Aave configuration this workflow
		// shipped with is exactly as cheap as it was before venue kinds existed.
		expect(plain.rpcRequests.length).toBe(2)
		expect(shared.rpcRequests.length).toBe(3)
	})

	test('the conversion follows the receipt, not the market', () => {
		// A second market with a different receipt: the fake answers 700 for anything that is not
		// aUSDC, so a conversion keyed on the wrong address would report 2,000 here as well.
		const { state, rpcRequests } = readSharePriced({ [OTHER_POOL.toLowerCase()]: other })
		expect(state.venues[0]?.receiptBalance).toBe(700_000_000n)
		expect(state.venues[0]?.supplied).toBe(2_800_000_000n)
		expect(rpcRequests.length).toBe(3)
	})
})

describe('readAccountState', () => {
	test('reads both sides of the account, the market, and its rate', () => {
		const { state } = read(onlyAave())
		expect(state).toEqual({
			agent: getAddress(agent),
			idle: 1_000_000_000n,
			venues: [
				{
					pool: AAVE_POOL.toLowerCase() as Address,
					kind: 'rebasing',
					venuePermitted: true,
					receipt: getAddress(AUSDC),
					receiptAsset: getAddress(USDC),
					supplied: 500_000_000n,
					receiptBalance: 500_000_000n,
					venueLiquidity: 29_318_183_885_841n,
					supplyRateRay: RATE,
				},
			],
			nonce: undefined,
		})
	})

	/**
	 * The order the contracts insist on: the market says which receipt it issues, and only then
	 * is that receipt asked anything. A forged receipt returns the real pool's address and would
	 * pass the question asked the other way round.
	 */
	test('takes the receipt from the market, then reads it in a second batch', () => {
		const { rpcRequests } = read(onlyAave())
		expect(rpcRequests).toHaveLength(2)
		const to = (batch: number) => rpcRequests[batch]?.map((r) => r.params[0].to.toLowerCase()) ?? []
		expect(to(0)).toEqual(
			[account, USDC, account, AAVE_POOL, AAVE_POOL, AAVE_POOL].map((a) => a.toLowerCase()),
		)
		expect(to(1)).toEqual([AUSDC.toLowerCase(), AUSDC.toLowerCase()])
	})

	/**
	 * Comparing markets costs more calls, not more waiting. Two batches whatever the number of
	 * markets is what keeps the enclave's round trips flat.
	 */
	test('reads several markets in the same two batches, in the order they were configured', () => {
		const { state, rpcRequests } = read(both)
		expect(rpcRequests).toHaveLength(2)
		const to = (batch: number) => rpcRequests[batch]?.map((r) => r.params[0].to.toLowerCase()) ?? []
		expect(to(0)).toEqual(
			[
				account,
				USDC,
				account,
				AAVE_POOL,
				AAVE_POOL,
				AAVE_POOL,
				account,
				OTHER_POOL,
				OTHER_POOL,
				OTHER_POOL,
			].map((a) => a.toLowerCase()),
		)
		expect(to(1)).toEqual([AUSDC, AUSDC, OTHER_RECEIPT, OTHER_RECEIPT].map((a) => a.toLowerCase()))
		expect(state.venues.map((v) => v.pool)).toEqual([
			AAVE_POOL.toLowerCase() as Address,
			OTHER_POOL.toLowerCase() as Address,
		])
	})

	/** Each market's own position and rate, and no chance of one being read as another's. */
	test("keeps every market's numbers with the market they came from", () => {
		const { state } = read(both)
		expect(state.venues[0]).toMatchObject({ supplied: 500_000_000n, supplyRateRay: RATE })
		expect(state.venues[1]).toMatchObject({
			supplied: 700_000_000n,
			supplyRateRay: OTHER_RATE,
			venueLiquidity: 4_000_000_000n,
			receipt: getAddress(OTHER_RECEIPT),
		})
	})

	test('a market that does not list the asset costs one batch and reports nothing supplied', () => {
		const { state, rpcRequests } = read(onlyAave(zeroAddress))
		expect(rpcRequests).toHaveLength(1)
		expect(state.venues[0]?.receipt).toBe(zeroAddress)
		expect(state.venues[0]?.receiptAsset).toBe(zeroAddress)
		expect(state.venues[0]?.supplied).toBe(0n)
		// The market's own numbers are still read; only the receipt's are missing.
		expect(state.venues[0]?.venueLiquidity).toBe(29_318_183_885_841n)
	})

	/**
	 * A market with no receipt contributes nothing to the second batch, and the markets that do
	 * still have to line up with their own answers. Getting that mapping wrong reads one market's
	 * position as another's, and both numbers look plausible.
	 */
	test('an unlisted market drops out of the second batch without shifting the others', () => {
		const { state, rpcRequests } = read({
			[AAVE_POOL.toLowerCase()]: aave(zeroAddress),
			[OTHER_POOL.toLowerCase()]: other,
		})
		expect(rpcRequests[1]?.map((r) => r.params[0].to.toLowerCase())).toEqual([
			OTHER_RECEIPT.toLowerCase(),
			OTHER_RECEIPT.toLowerCase(),
		])
		expect(state.venues[0]?.supplied).toBe(0n)
		expect(state.venues[1]?.supplied).toBe(700_000_000n)
	})

	/**
	 * `HelicoAccount.nonce()` takes no argument, where `HelicoVault.nonces(address)` took the
	 * owner. Encoded with an argument it is a different selector and the call reverts, so the
	 * calldata length is the assertion: four bytes, no words. It is also the last call in the
	 * batch, behind however many markets there are.
	 */
	test('asks for the nonce with no argument, and only when it is going to sign', () => {
		const { state, rpcRequests } = read(both, { withNonce: true })
		expect(state.nonce).toBe(7n)
		expect(rpcRequests[0]).toHaveLength(11)
		expect(rpcRequests[0]?.[10]?.params[0].data).toBe(toFunctionSelector('function nonce()'))
		expect(read(both).rpcRequests[0]).toHaveLength(10)
	})
})
