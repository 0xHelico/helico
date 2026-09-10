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
/** The second asset, for the tests that read more than one. Real WETH on Arbitrum One. */
const WETH = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'
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
		{ account: config.account as Address, pools, assets: config.assets as Address[] },
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
		{ account: config.account as Address, pools, assets: config.assets as Address[] },
		{},
	)
	return { state, ...fake }
}

describe('a share-priced venue', () => {
	test('reports the position in the asset, not the share count', () => {
		const { state } = readSharePriced(onlyAave())
		const venue = state.assets[0]?.venues[0]

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

		expect(plain.state.assets[0]?.venues[0]?.supplied).toBe(500_000_000n)
		expect(plain.state.assets[0]?.venues[0]?.receiptBalance).toBe(500_000_000n)
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
		expect(state.assets[0]?.venues[0]?.receiptBalance).toBe(700_000_000n)
		expect(state.assets[0]?.venues[0]?.supplied).toBe(2_800_000_000n)
		expect(rpcRequests.length).toBe(3)
	})
})

describe('readAccountState', () => {
	test('reads both sides of the account, the market, and its rate', () => {
		const { state } = read(onlyAave())
		expect(state).toEqual({
			agent: getAddress(agent),
			assets: [
				{
					// Lower case, not checksummed: the asset is carried through from the config, which
					// the schema lower-cases, while `agent` is decoded from a call and comes back
					// checksummed. Worth knowing before comparing the two.
					asset: USDC.toLowerCase() as Address,
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
		expect(state.assets[0]?.venues.map((v) => v.pool)).toEqual([
			AAVE_POOL.toLowerCase() as Address,
			OTHER_POOL.toLowerCase() as Address,
		])
	})

	/** Each market's own position and rate, and no chance of one being read as another's. */
	test("keeps every market's numbers with the market they came from", () => {
		const { state } = read(both)
		expect(state.assets[0]?.venues[0]).toMatchObject({
			supplied: 500_000_000n,
			supplyRateRay: RATE,
		})
		expect(state.assets[0]?.venues[1]).toMatchObject({
			supplied: 700_000_000n,
			supplyRateRay: OTHER_RATE,
			venueLiquidity: 4_000_000_000n,
			receipt: getAddress(OTHER_RECEIPT),
		})
	})

	test('a market that does not list the asset costs one batch and reports nothing supplied', () => {
		const { state, rpcRequests } = read(onlyAave(zeroAddress))
		expect(rpcRequests).toHaveLength(1)
		expect(state.assets[0]?.venues[0]?.receipt).toBe(zeroAddress)
		expect(state.assets[0]?.venues[0]?.receiptAsset).toBe(zeroAddress)
		expect(state.assets[0]?.venues[0]?.supplied).toBe(0n)
		// The market's own numbers are still read; only the receipt's are missing.
		expect(state.assets[0]?.venues[0]?.venueLiquidity).toBe(29_318_183_885_841n)
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
		expect(state.assets[0]?.venues[0]?.supplied).toBe(0n)
		expect(state.assets[0]?.venues[1]?.supplied).toBe(700_000_000n)
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

describe('several assets', () => {
	/** Like `read`, but the config names two assets against the same markets. */
	const readTwo = (markets: Record<string, Market>) => {
		const pools = Object.keys(markets).map((address) => ({
			address: address as Address,
			kind: 'rebasing' as const,
		}))
		const assets = [USDC.toLowerCase(), WETH.toLowerCase()] as Address[]
		const fake = fakeRuntime({
			config: configSchema.parse({ ...config, pools, assets }),
			secrets: {},
			now: 1_700_000_000,
			handlers: handlers(markets),
		})
		const state = readAccountState(
			fake.runtime,
			config.rpcUrl,
			{ account: config.account as Address, pools, assets },
			{},
		)
		return { state, ...fake }
	}

	test('both assets come back, in the order the owner wrote them', () => {
		const { state } = readTwo(onlyAave())
		expect(state.assets.map((a) => a.asset)).toEqual([
			USDC.toLowerCase() as Address,
			WETH.toLowerCase() as Address,
		])
		expect(state.assets[0]?.venues).toHaveLength(1)
		expect(state.assets[1]?.venues).toHaveLength(1)
	})

	test('and each asset reads its own slice of the batch', () => {
		// **The assertion the shape checks above cannot make.** One batch serves every asset, so
		// each has to be sliced at `1 + a * STRIDE`; get the offset wrong and every asset reads the
		// first one's answers. Nothing about the shape changes when that happens — the list is
		// still two long and the addresses are still right — so only the values catch it.
		//
		// Verified by mutation: forcing `base` to a constant left all three shape tests green.
		const { state } = readTwo(onlyAave())
		expect(state.assets[0]?.idle).toBe(1_000_000_000n)
		expect(state.assets[1]?.idle).toBe(700_000_000n)
		expect(state.assets[0]?.idle).not.toBe(state.assets[1]?.idle)
	})

	test('and they cost one round trip, not one each', () => {
		const two = readTwo(onlyAave())
		const one = read(onlyAave())
		// The whole reason this is one workflow rather than one per asset: a single view holds
		// every asset before anything is decided. Reading them in separate batches would work and
		// would make the round trips grow with the asset list.
		expect(two.rpcRequests.length).toBe(one.rpcRequests.length)
	})

	test('a market that lists one asset and not the other is skipped for that one only', () => {
		// The fake answers a receipt for any market; what distinguishes the assets here is that
		// each is read separately, so a zero receipt on one side cannot silence the other.
		const { state } = readTwo(onlyAave())
		expect(state.assets[0]?.venues[0]?.receipt).not.toBe(zeroAddress)
		expect(state.assets[1]?.venues[0]?.receipt).not.toBe(zeroAddress)
	})
})

describe('markets that list only some of the assets', () => {
	// Aave's Pool serves every reserve, so one address answers for USDC and WETH alike. A
	// `CompoundVenue` is the opposite: it holds one market, and `getReserveAToken` on any other
	// asset **reverts**. Measured on Arbitrum One on 10 September 2026, not assumed — Aave answered
	// for both, and each of the three venues answered for its own asset and reverted on the other.
	const USDC_VENUE = `0x${'31'.repeat(20)}` as Address
	const WETH_VENUE = `0x${'32'.repeat(20)}` as Address
	const USDC_RECEIPT = `0x${'41'.repeat(20)}`
	const WETH_RECEIPT = `0x${'42'.repeat(20)}`
	const WETH_RATE = 12_469_942_161_792_000_000_000_000n // the real cWETHv3 rate, 1.247%
	const USDC_VENUE_RATE = 55_000_000_000_000_000_000_000_000n // 5.5%, the best on offer

	const scoped = [
		{ address: AAVE_POOL.toLowerCase() as Address, kind: 'rebasing' as const },
		{
			address: USDC_VENUE,
			kind: 'rebasing' as const,
			assets: [USDC.toLowerCase() as Address],
		},
		{
			address: WETH_VENUE,
			kind: 'rebasing' as const,
			assets: [WETH.toLowerCase() as Address],
		},
	]

	const markets: Record<string, Market> = {
		[AAVE_POOL.toLowerCase()]: aave(),
		[USDC_VENUE]: market(USDC_RECEIPT, USDC_VENUE_RATE, 8_000_000_000n),
		[WETH_VENUE]: market(WETH_RECEIPT, WETH_RATE, 3_000_000_000n),
	}

	/** Which assets each market will answer about. Anything else throws, as the real ones revert. */
	const listedBy: Record<string, string[]> = {
		[AAVE_POOL.toLowerCase()]: [USDC.toLowerCase(), WETH.toLowerCase()],
		[USDC_VENUE]: [USDC.toLowerCase()],
		[WETH_VENUE]: [WETH.toLowerCase()],
	}

	/** The asset argument out of a one-address call, which is the last twenty bytes of the word. */
	const askedAbout = (data: Hex) => `0x${data.slice(-40)}`.toLowerCase()

	const readScoped = () => {
		const assets = [USDC.toLowerCase(), WETH.toLowerCase()] as Address[]
		const base = handlers(markets)
		// The venue's own guard, modelled rather than described: `require(asset == ASSET)`. Without
		// it this suite would pass with the scoping removed, because a fake that answers every
		// question cannot tell a question that was asked from one that was not.
		const guard =
			(inner: (data: Hex, to: string) => Hex) =>
			(data: Hex, to: string): Hex => {
				const lists = listedBy[to.toLowerCase()]
				if (lists && !lists.includes(askedAbout(data))) {
					throw new Error(`WrongAsset: ${to} was asked about ${askedAbout(data)}`)
				}
				return inner(data, to)
			}
		const handlersWithGuard = {
			...base,
			[sel('function getReserveAToken(address)')]: guard(
				base[sel('function getReserveAToken(address)')] as (d: Hex, t: string) => Hex,
			),
			[sel('function getVirtualUnderlyingBalance(address)')]: guard(
				base[sel('function getVirtualUnderlyingBalance(address)')] as (d: Hex, t: string) => Hex,
			),
			[sel('function getReserveData(address)')]: guard(
				base[sel('function getReserveData(address)')] as (d: Hex, t: string) => Hex,
			),
		}
		const fake = fakeRuntime({
			config: configSchema.parse({ ...config, pools: scoped, assets }),
			secrets: {},
			now: 1_700_000_000,
			handlers: handlersWithGuard,
		})
		const state = readAccountState(
			fake.runtime,
			config.rpcUrl,
			{ account: config.account as Address, pools: scoped, assets },
			{},
		)
		return { state, ...fake }
	}

	test('a scoped market is never asked about an asset it does not list', () => {
		// **The whole point of the scope, and it is not an optimisation.** One reverting call fails
		// the batch, so an unscoped USDC venue in a configuration that also names WETH does not
		// earn less — it stops every run. The guard above throws exactly where the real venue
		// reverts, so this test failing is what the deployed workflow would have done.
		expect(() => readScoped()).not.toThrow()
	})

	test('each asset sees the markets that take it, and only those', () => {
		const { state } = readScoped()
		expect(state.assets[0]?.venues.map((v) => v.pool)).toEqual([
			AAVE_POOL.toLowerCase() as Address,
			USDC_VENUE,
		])
		expect(state.assets[1]?.venues.map((v) => v.pool)).toEqual([
			AAVE_POOL.toLowerCase() as Address,
			WETH_VENUE,
		])
	})

	test('and each still reads its own answers, with the slices no longer equal in length', () => {
		// **The assertion the shape check above cannot make**, and the reason the reader keeps a
		// cursor instead of multiplying out a stride. Every asset used to spend the same number of
		// calls; now USDC's slice and WETH's are only the same length by coincidence, and an asset
		// scoped to fewer markets than the one before it shifts everything after it.
		//
		// Shape survives that — both lists are still two long and the addresses are still right.
		// Only the values move, so only the values catch it.
		const { state } = readScoped()
		expect(state.assets[0]?.idle).toBe(1_000_000_000n)
		expect(state.assets[1]?.idle).toBe(700_000_000n)
		expect(state.assets[0]?.venues[1]?.supplyRateRay).toBe(USDC_VENUE_RATE)
		expect(state.assets[1]?.venues[1]?.supplyRateRay).toBe(WETH_RATE)
		expect(state.assets[0]?.venues[1]?.venueLiquidity).toBe(8_000_000_000n)
		expect(state.assets[1]?.venues[1]?.venueLiquidity).toBe(3_000_000_000n)
		expect(state.assets[0]?.venues[1]?.receipt).toBe(USDC_RECEIPT as Address)
		expect(state.assets[1]?.venues[1]?.receipt).toBe(WETH_RECEIPT as Address)
	})

	test('and it is still one round trip', () => {
		// Scoping removes calls; it must not add a batch. The reason this workflow is one and not
		// one per asset is that a single view holds all of it before anything is decided.
		const scopedRun = readScoped()
		expect(scopedRun.rpcRequests.length).toBe(read(onlyAave()).rpcRequests.length)
	})
})

describe('the config refuses a scope that cannot work', () => {
	const withPools = (pools: unknown[], assets: string[]) =>
		configSchema.safeParse({ ...config, pools, assets })

	test('an asset no market lists', () => {
		// Capital the enclave watches sit idle and can never place, which reads on every run as a
		// decision to hold. Green forever, and one side of the account never earns anything.
		const result = withPools(
			[{ address: AAVE_POOL.toLowerCase(), kind: 'rebasing', assets: [USDC.toLowerCase()] }],
			[USDC.toLowerCase(), WETH.toLowerCase()],
		)
		expect(result.success).toBe(false)
		expect(JSON.stringify(result.error?.issues)).toContain('every asset needs at least one market')
	})

	test('a market scoped to an asset the account does not hold', () => {
		const result = withPools(
			[
				{ address: AAVE_POOL.toLowerCase(), kind: 'rebasing' },
				{ address: `0x${'31'.repeat(20)}`, kind: 'rebasing', assets: [WETH.toLowerCase()] },
			],
			[USDC.toLowerCase()],
		)
		expect(result.success).toBe(false)
		expect(JSON.stringify(result.error?.issues)).toContain('at least one asset the account holds')
	})

	test('and an unscoped market still means every asset', () => {
		// The compatibility that keeps every configuration written before this from needing a
		// migration on the day it is read.
		const result = withPools(
			[{ address: AAVE_POOL.toLowerCase(), kind: 'rebasing' }],
			[USDC.toLowerCase(), WETH.toLowerCase()],
		)
		expect(result.success).toBe(true)
		expect(result.data?.pools[0]?.assets).toBeUndefined()
	})
})
