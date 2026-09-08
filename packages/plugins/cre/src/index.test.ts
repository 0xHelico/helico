import { describe, expect, test } from 'bun:test'
import {
	type Address,
	bytesToHex,
	decodeAbiParameters,
	encodeAbiParameters,
	getAddress,
	type Hex,
	parseAbiParameters,
	toFunctionSelector,
	zeroAddress,
} from 'viem'
import {
	type Config,
	configSchema,
	configShape,
	deliver,
	encodeReport,
	idleMoveParamsAbi,
	initWorkflow,
	onCronTrigger,
	POLICY_SECRET_IDS,
	policyHash,
	recoverIdleMoveSigner,
} from './index'
import { fakeRuntime, RpcError } from './test/fakeRuntime'

// ─── Fixtures: Aave v3 and USDC on Arbitrum One, verified 8 September 2026 ───
const AAVE_POOL = '0x794a61358D6845594F94dc1DB02A252b5b4814aD'
const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
const AUSDC = '0x724dc807b04555b71ed48a6896b6F41593b8C637'
/** A second Aave-family market and its receipt. Only their addresses matter to these tests. */
const OTHER_POOL = `0x${'22'.repeat(20)}`
const OTHER_RECEIPT = `0x${'23'.repeat(20)}`
const account = getAddress('0x746182d0cccc5cefc69853bb0325c850029388c0')
// Anvil's first account. The enclave holds the key behind it in signature mode.
const agent = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const agentKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

/** USDC has six decimals, so every amount below is `whole * 1e6`. */
const usdc = (whole: number): bigint => BigInt(whole) * 1_000_000n
const RATE = 27_514_566_416_591_863_466_760_475n // 2.75%, the live USDC rate on the day
/** A rate as a ray: 1e27 is 100%. */
const percent = (pct: number): bigint => BigInt(Math.round(pct * 100)) * 10n ** 23n

const secrets = {
	[POLICY_SECRET_IDS.targetWorkingBps]: '8000',
	[POLICY_SECRET_IDS.minIdleAmount]: '100000000',
	[POLICY_SECRET_IDS.minMoveAmount]: '25000000',
	[POLICY_SECRET_IDS.minMoveBps]: '50',
	[POLICY_SECRET_IDS.minSupplyRateRay]: '0',
	[POLICY_SECRET_IDS.maxMoveAmount]: '1000000000000',
	[POLICY_SECRET_IDS.expiry]: '2000000000',
}
const committedHash = policyHash({
	targetWorkingBps: 8_000,
	minIdleAmount: usdc(100),
	minMoveAmount: usdc(25),
	minMoveBps: 50,
	minSupplyRateRay: 0n,
	maxMoveAmount: usdc(1_000_000),
	expiry: 2_000_000_000,
})

const config: Config = {
	// The explanation is off by default in these tests: an empty `aiUrl` means the workflow asks
	// for no AI secrets and calls no model, so every assertion below is about the decision rather
	// than about prose. `ai.test.ts` covers the other path.
	aiUrl: '',
	aiModel: 'ag/claude-opus-4-6-thinking',
	aiFallbackModel: 'ag/gemini-3-flash',
	aiMaxTokens: 1200,
	aiTimeoutSeconds: 30,
	// The subgraph is off by default here for the same reason `aiUrl` is: an empty endpoint means
	// no request is made and the buffer is the owner's `minIdleAmount` alone, which is what every
	// assertion below was written against. `the Aqua buffer` covers the other path.
	subgraphUrl: '',
	subgraphTimeoutSeconds: 20,
	schedule: '0 */5 * * * *',
	rpcUrl: 'https://arb1.arbitrum.io/rpc',
	delivery: 'forwarder',
	chainSelectorName: 'ethereum-mainnet-arbitrum-1',
	domainName: 'HelicoAccount',
	domainVersion: '1',
	agentKeySecretId: 'AGENT_KEY',
	nonceFunction: 'nonce',
	account: account.toLowerCase(),
	pools: [AAVE_POOL.toLowerCase()],
	asset: USDC.toLowerCase(),
	agent: agent.toLowerCase(),
	reportReceiver: '0x3333333333333333333333333333333333333333',
	policyHash: committedHash,
	gasLimit: '1500000',
	deadlineSeconds: 600,
}
const now = 1_700_000_000

/** One market, with everything the enclave reads about it. */
type VenueFixture = {
	pool: string
	permitted?: boolean
	receipt?: string
	receiptAsset?: string
	supplied: bigint
	venueLiquidity?: bigint
	rate?: bigint
}

type Chain = {
	agent?: Address
	idle: bigint
	nonce?: bigint
	venues: VenueFixture[]
}

const sel = (sig: string): Hex => toFunctionSelector(sig)
const word = (x: bigint | number | boolean | string): Hex =>
	typeof x === 'string'
		? encodeAbiParameters([{ type: 'address' }], [x as Address])
		: encodeAbiParameters([{ type: 'uint256' }], [BigInt(x)])

/**
 * The reads the enclave makes, answered from one description of the chain.
 *
 * Three of them need more than the selector to answer. `permittedVenue` is asked of the *account*
 * with the market as its argument, so it dispatches on the calldata; `balanceOf` is asked of the
 * asset and of every receipt, so it dispatches on the address; and everything a market answers is
 * looked up by which market was asked.
 */
const handlers = (c: Chain) => {
	const receiptOf = (venue: VenueFixture) => venue.receipt ?? AUSDC
	const marketAt = (to: string): VenueFixture => {
		const found = c.venues.find((venue) => venue.pool.toLowerCase() === to.toLowerCase())
		if (!found) throw new Error(`unmodelled market ${to}`)
		return found
	}
	const behindReceipt = (to: string): VenueFixture => {
		const found = c.venues.find((venue) => receiptOf(venue).toLowerCase() === to.toLowerCase())
		if (!found) throw new Error(`unmodelled receipt ${to}`)
		return found
	}
	return {
		[sel('function agent()')]: () => word(c.agent ?? agent),
		[sel('function permittedVenue(address)')]: (data: Hex) =>
			word(marketAt(`0x${data.slice(-40)}`).permitted ?? true),
		[sel('function nonce()')]: () => word(c.nonce ?? 0n),
		[sel('function getReserveAToken(address)')]: (_: Hex, to: string) =>
			word(receiptOf(marketAt(to))),
		[sel('function getVirtualUnderlyingBalance(address)')]: (_: Hex, to: string) =>
			word(marketAt(to).venueLiquidity ?? 29_318_183_885_841n),
		[sel('function UNDERLYING_ASSET_ADDRESS()')]: (_: Hex, to: string) =>
			word(behindReceipt(to).receiptAsset ?? USDC),
		[sel('function balanceOf(address)')]: (_: Hex, to: string) =>
			word(to.toLowerCase() === USDC.toLowerCase() ? c.idle : behindReceipt(to).supplied),
		[sel('function getReserveData(address)')]: (_: Hex, to: string) =>
			encodeAbiParameters(
				parseAbiParameters(
					'(uint256, uint128, uint128, uint128, uint128, uint128, uint40, uint16, address, address, address, address, uint128, uint128, uint128)',
				),
				[
					[
						0n,
						10n ** 27n,
						marketAt(to).rate ?? RATE,
						10n ** 27n,
						0n,
						0n,
						now,
						12,
						receiptOf(marketAt(to)) as Address,
						zeroAddress,
						zeroAddress,
						zeroAddress,
						0n,
						0n,
						0n,
					],
				],
			),
	}
}

type Faults = {
	writeStatus?: number
	httpStatus?: number
	rpcBody?: string
	secrets?: Record<string, string>
	graphStatus?: number
	graphBody?: string
	graphThrows?: boolean
}
const run = async (chain: Chain, overrides: Partial<Config> = {}, faults: Faults = {}) => {
	const fake = fakeRuntime({
		config: configSchema.parse({ ...config, ...overrides }),
		secrets: faults.secrets ?? secrets,
		now,
		handlers: handlers(chain),
		writeStatus: faults.writeStatus,
		httpStatus: faults.httpStatus,
		rpcBody: faults.rpcBody,
		graphStatus: faults.graphStatus,
		graphBody: faults.graphBody,
		graphThrows: faults.graphThrows,
	})
	const result = await onCronTrigger(fake.runtime)
	return { ...fake, result }
}

const decodeReport = (rawReport: Uint8Array) =>
	decodeAbiParameters(
		[{ type: 'bool' }, { type: 'bytes32' }, idleMoveParamsAbi],
		bytesToHex(rawReport),
	)

/** The single-market account this workflow started as. */
const one = (idle: bigint, supplied: bigint, over: Partial<VenueFixture> = {}): Chain => ({
	idle,
	venues: [{ pool: AAVE_POOL, supplied, ...over }],
})

/** Two markets, and the config that lets the enclave choose between them. */
const two = (
	idle: bigint,
	aave: Partial<VenueFixture> & { supplied: bigint },
	other: Partial<VenueFixture> & { supplied: bigint },
): Chain => ({
	idle,
	venues: [
		{ pool: AAVE_POOL, ...aave },
		{ pool: OTHER_POOL, receipt: OTHER_RECEIPT, ...other },
	],
})
const bothPools: Partial<Config> = { pools: [AAVE_POOL.toLowerCase(), OTHER_POOL] }

/** 1,000 USDC sitting idle and nothing working: 800 of it should be at the market. */
const allIdle: Chain = one(usdc(1_000), 0n)

/** What the enclave prints and what a report carries is the lowercased config address. */
const aave = AAVE_POOL.toLowerCase()

// ─── Tests ───────────────────────────────────────────────────
describe('configSchema', () => {
	test('carries no threshold: every one of them comes from a secret', () => {
		for (const key of Object.keys(POLICY_SECRET_IDS)) {
			expect(Object.keys(configShape)).not.toContain(key)
		}
	})

	test('lowercases hex values so a checksummed config compares equal to what the chain returns', () => {
		const parsed = configSchema.parse({ ...config, pools: [AAVE_POOL], asset: USDC, agent })
		expect(parsed.pools).toEqual([aave])
		expect(parsed.asset).toBe(USDC.toLowerCase())
		expect(parsed.agent).toBe(agent.toLowerCase())
	})

	test('ties chainId to signature delivery and chainSelectorName to the forwarder', () => {
		expect(() => configSchema.parse({ ...config, delivery: 'signature' })).toThrow('chainId')
		expect(() => configSchema.parse({ ...config, chainSelectorName: undefined })).toThrow(
			'chainSelectorName',
		)
		expect(configSchema.parse({ ...config, delivery: 'signature', chainId: 42_161 }).delivery).toBe(
			'signature',
		)
	})

	/** A list of one is the single-market configuration, and it has to keep parsing. */
	test('takes one market or several, and refuses none at all', () => {
		expect(configSchema.parse({ ...config, ...bothPools }).pools).toHaveLength(2)
		expect(() => configSchema.parse({ ...config, pools: [] })).toThrow()
	})

	/**
	 * A market named twice is read twice and then compared against itself, which is a rate gap of
	 * zero dressed up as a choice. The two readings of a repeated address are not the same wish,
	 * so neither is guessed at.
	 */
	test('refuses the same market twice, however it was cased', () => {
		expect(() => configSchema.parse({ ...config, pools: [AAVE_POOL, aave] })).toThrow(
			'pools must not repeat a market',
		)
	})
})

describe('onCronTrigger', () => {
	test('refuses, and never reads the chain, when the secrets do not match the published hash', async () => {
		const { result, rpcRequests, writes } = await run(allIdle, {
			policyHash: `0x${'ab'.repeat(32)}`,
		})
		expect(result).toBe('HOLD (policy hash mismatch)')
		expect(rpcRequests).toHaveLength(0)
		expect(writes).toHaveLength(0)
	})

	/** A zero hash is the owner saying they published none, not a hash that happens to be zero. */
	test('a zero hash means nothing was committed, and the run goes ahead', async () => {
		const { result } = await run(allIdle, { policyHash: `0x${'0'.repeat(64)}` })
		expect(result).toStartWith('SUPPLY')
	})

	test('reads the account and the market, then the receipt, in two batches from inside the enclave', async () => {
		const { rpcRequests } = await run(allIdle)
		expect(rpcRequests).toHaveLength(2)
		const lower = (a: string) => a.toLowerCase()
		expect(rpcRequests[0]?.map((r) => lower(r.params[0].to))).toEqual(
			[account, USDC, account, AAVE_POOL, AAVE_POOL, AAVE_POOL].map(lower),
		)
		// The receipt's address came out of the first batch, from the market. Asking the receipt
		// which market it belongs to would read as the same check and is not one.
		expect(rpcRequests[1]?.map((r) => lower(r.params[0].to))).toEqual([lower(AUSDC), lower(AUSDC)])
	})

	test.each([
		[
			'the owner revoked the agent',
			{ ...allIdle, agent: zeroAddress },
			'HOLD (the account has not nominated this agent)',
		],
		[
			'the owner nominated somebody else',
			{ ...allIdle, agent: AAVE_POOL as Address },
			'HOLD (the account has not nominated this agent)',
		],
		[
			'the owner took the venue off the allowlist',
			one(usdc(1_000), 0n, { permitted: false }),
			'HOLD (the owner has not permitted this venue)',
		],
		[
			'the market does not list the asset',
			one(usdc(1_000), 0n, { receipt: zeroAddress }),
			'HOLD (the venue does not list this asset)',
		],
		[
			'the receipt is for a different asset',
			one(usdc(1_000), 0n, { receiptAsset: AAVE_POOL }),
			"HOLD (the venue's receipt is for a different asset)",
		],
		['the account is empty', one(0n, 0n), 'HOLD (the account holds nothing to place)'],
		['the split is already met', one(usdc(200), usdc(800)), 'HOLD (already at the target split)'],
		[
			'the drift is smaller than the deadband',
			one(usdc(210), usdc(800)),
			'HOLD (inside the deadband)',
		],
	] as [string, Chain, string][])(
		'holds when %s, and writes nothing',
		async (_, chain, expected) => {
			const { result, writes } = await run(chain)
			expect(result).toBe(expected)
			expect(writes).toHaveLength(0)
		},
	)

	/** No receipt means no second batch: there is nothing to ask and nowhere to ask it. */
	test('an unlisted asset costs one batch, not two', async () => {
		const { rpcRequests } = await run(one(usdc(1_000), 0n, { receipt: zeroAddress }))
		expect(rpcRequests).toHaveLength(1)
	})

	test('holds when the policy has expired', async () => {
		const expired = { ...secrets, [POLICY_SECRET_IDS.expiry]: '1600000000' }
		const hash = policyHash({
			targetWorkingBps: 8_000,
			minIdleAmount: usdc(100),
			minMoveAmount: usdc(25),
			minMoveBps: 50,
			minSupplyRateRay: 0n,
			maxMoveAmount: usdc(1_000_000),
			expiry: 1_600_000_000,
		})
		const { result } = await run(allIdle, { policyHash: hash }, { secrets: expired })
		expect(result).toBe('HOLD (policy expired)')
	})

	test('holds when the market pays less than the owner asked for', async () => {
		const floor = { ...secrets, [POLICY_SECRET_IDS.minSupplyRateRay]: '30000000000000000000000000' }
		const hash = policyHash({
			targetWorkingBps: 8_000,
			minIdleAmount: usdc(100),
			minMoveAmount: usdc(25),
			minMoveBps: 50,
			minSupplyRateRay: 30_000_000_000_000_000_000_000_000n,
			maxMoveAmount: usdc(1_000_000),
			expiry: 2_000_000_000,
		})
		const { result } = await run(allIdle, { policyHash: hash }, { secrets: floor })
		expect(result).toBe('HOLD (every venue pays below the policy floor)')
	})

	test('supplies the excess and delivers the move as a report', async () => {
		const { result, writes, reports } = await run(allIdle)
		expect(result).toBe(`SUPPLY 800000000 to ${aave} tx 0x${'ab'.repeat(32)}`)
		expect(writes).toHaveLength(1)
		const write = writes[0] as NonNullable<(typeof writes)[0]>
		expect(bytesToHex(write.receiver)).toBe(config.reportReceiver as Hex)
		expect(write.gasConfig?.gasLimit).toBe(1_500_000n)
		const [act, hash, p] = decodeReport(write.report?.rawReport ?? new Uint8Array())
		expect(act).toBe(true)
		expect(hash).toBe(committedHash)
		expect(p.account).toBe(account)
		expect(p.pool).toBe(getAddress(AAVE_POOL))
		expect(p.asset).toBe(getAddress(USDC))
		expect(p.supply).toBe(true)
		expect(p.amount).toBe(usdc(800))
		expect(p.deadline).toBe(BigInt(now + 600))
		expect(reports).toHaveLength(1)
	})

	test('withdraws when the account has fallen below the buffer it needs to cover a swap', async () => {
		const { result, writes } = await run(one(usdc(10), usdc(990)))
		expect(result).toBe(`WITHDRAW 190000000 from ${aave} tx 0x${'ab'.repeat(32)}`)
		const [, , p] = decodeReport(writes[0]?.report?.rawReport ?? new Uint8Array())
		expect(p.supply).toBe(false)
		expect(p.amount).toBe(usdc(190))
	})

	/**
	 * Revoking is an instruction, not a pause. The table above has the same market revoked with
	 * nothing in it and that one holds — the difference between the two rows is the behaviour.
	 */
	test('unwinds the whole position when the owner revokes a market it is sitting in', async () => {
		const { result, writes } = await run(one(usdc(10), usdc(990), { permitted: false }))
		expect(result).toBe(`WITHDRAW 990000000 from ${aave} tx 0x${'ab'.repeat(32)}`)
		const [, , p] = decodeReport(writes[0]?.report?.rawReport ?? new Uint8Array())
		expect(p.supply).toBe(false)
		// All of it, not the split's 190. The split and the deadband are for moves worth making;
		// this one was asked for.
		expect(p.amount).toBe(usdc(990))
	})

	test('leaving a revoked market outranks the ordinary move the split would have made', async () => {
		const { result } = await run(
			two(
				usdc(1_000),
				{ supplied: usdc(500), permitted: false },
				{ supplied: 0n, rate: percent(5) },
			),
			bothPools,
		)
		// Without the evacuation this run supplies the 5% market, which is the better trade and
		// the wrong answer: it would place more money while the owner is trying to withdraw some.
		expect(result).toBe(`WITHDRAW 500000000 from ${aave} tx 0x${'ab'.repeat(32)}`)
	})

	/**
	 * The deadband is applied twice, and this is why. The split asked for 190 USDC, which clears
	 * it easily; a drained market leaves 3, which does not. Without the second check the run
	 * would pay gas to move three dollars because the market could not manage the rest.
	 */
	test('holds when the market can only return a fragment of what was wanted', async () => {
		const { result, writes } = await run(one(usdc(10), usdc(990), { venueLiquidity: usdc(3) }))
		expect(result).toBe('HOLD (no venue can return enough to be worth a move)')
		expect(writes).toHaveLength(0)
	})

	test('holds when the market can return nothing at all', async () => {
		const { result } = await run(one(usdc(10), usdc(990), { venueLiquidity: 0n }))
		expect(result).toBe('HOLD (no venue can return enough to be worth a move)')
	})

	test('a market that can only pay part of it still moves that part, when the part is worth moving', async () => {
		const { result } = await run(one(usdc(10), usdc(990), { venueLiquidity: usdc(120) }))
		expect(result).toStartWith('WITHDRAW 120000000')
	})

	test('the per-move ceiling bounds what one run can do', async () => {
		const capped = { ...secrets, [POLICY_SECRET_IDS.maxMoveAmount]: '100000000' }
		const hash = policyHash({
			targetWorkingBps: 8_000,
			minIdleAmount: usdc(100),
			minMoveAmount: usdc(25),
			minMoveBps: 50,
			minSupplyRateRay: 0n,
			maxMoveAmount: usdc(100),
			expiry: 2_000_000_000,
		})
		const { result } = await run(allIdle, { policyHash: hash }, { secrets: capped })
		expect(result).toStartWith('SUPPLY 100000000')
	})

	test.each([
		['a non-200 answer', { httpStatus: 502 }, 'RPC returned status 502'],
		[
			'a single error object instead of the batch',
			{ rpcBody: '{"jsonrpc":"2.0","error":{"message":"rate limited"}}' },
			'did not answer the batch',
		],
		[
			'a reply with a missing result',
			{ rpcBody: '[{"jsonrpc":"2.0","id":0,"error":{"message":"execution reverted"}}]' },
			'eth_call 0 failed: execution reverted',
		],
	])('fails loudly on %s rather than deciding on a partial view', async (_, faults, message) => {
		await expect(run(allIdle, {}, faults)).rejects.toThrow(message)
	})
})

// ─── Several markets ─────────────────────────────────────────
describe('choosing between markets', () => {
	test('supplies to the better of two markets, and names it', async () => {
		const { result, writes } = await run(
			two(usdc(1_000), { supplied: 0n, rate: percent(2) }, { supplied: 0n, rate: percent(5) }),
			bothPools,
		)
		expect(result).toBe(`SUPPLY 800000000 to ${OTHER_POOL} tx 0x${'ab'.repeat(32)}`)
		const [, , p] = decodeReport(writes[0]?.report?.rawReport ?? new Uint8Array())
		expect(p.pool).toBe(getAddress(OTHER_POOL))
	})

	/** Reading two markets is still two round trips; the batches get longer, not more numerous. */
	test('reads every market in the same two batches', async () => {
		const { rpcRequests } = await run(
			two(usdc(1_000), { supplied: 0n }, { supplied: 0n }),
			bothPools,
		)
		expect(rpcRequests).toHaveLength(2)
		expect(rpcRequests[0]).toHaveLength(10)
		expect(rpcRequests[1]).toHaveLength(4)
	})

	/**
	 * The rule `_venueFor` follows in the contract, now in the workflow: a market the account
	 * cannot use disqualifies itself and not the run.
	 */
	test('a market the owner has not permitted is skipped, not fatal', async () => {
		const { result } = await run(
			two(
				usdc(1_000),
				{ supplied: 0n, rate: percent(2) },
				{ supplied: 0n, rate: percent(5), permitted: false },
			),
			bothPools,
		)
		expect(result).toBe(`SUPPLY 800000000 to ${aave} tx 0x${'ab'.repeat(32)}`)
	})

	test('a market that does not list the asset is skipped too', async () => {
		const { result } = await run(
			two(
				usdc(1_000),
				{ supplied: 0n, rate: percent(2) },
				{ supplied: 0n, rate: percent(5), receipt: zeroAddress },
			),
			bothPools,
		)
		expect(result).toStartWith(`SUPPLY 800000000 to ${aave}`)
	})

	/**
	 * With one market, "the venue does not list this asset" is the whole answer. With several it
	 * answers nothing unless it says which, so every refusal arrives with its address.
	 */
	test('when nothing is usable, the hold names each market and why', async () => {
		const { result, writes } = await run(
			two(usdc(1_000), { supplied: 0n, permitted: false }, { supplied: 0n, receipt: zeroAddress }),
			bothPools,
		)
		expect(result).toBe(
			`HOLD (no venue is usable (${aave} — the owner has not permitted this venue; ${OTHER_POOL} — the venue does not list this asset))`,
		)
		expect(writes).toHaveLength(0)
	})

	test('takes liquidity out of the market paying least for it', async () => {
		const { result } = await run(
			two(
				usdc(10),
				{ supplied: usdc(500), rate: percent(2) },
				{ supplied: usdc(490), rate: percent(5) },
			),
			bothPools,
		)
		expect(result).toStartWith(`WITHDRAW 190000000 from ${aave}`)
	})
})

// ─── Migration ───────────────────────────────────────────────
/**
 * The account is where the policy wants it and the capital is in the wrong place. `nonce` is
 * strictly sequential, so one signed statement authorises one call: the worse market is emptied
 * now and the better one is filled by the next run's ordinary supply.
 */
describe('migrating between markets', () => {
	/** 1,000 in total with 200 idle: exactly the target split, so nothing to rebalance. */
	const spread = (aaveRate: number, otherRate: number, over: Partial<VenueFixture> = {}) =>
		two(
			usdc(200),
			{ supplied: usdc(400), rate: percent(aaveRate), ...over },
			{ supplied: usdc(400), rate: percent(otherRate) },
		)

	test('empties the worse market, and leaves the supply to the next run', async () => {
		const { result, writes } = await run(spread(2, 5), bothPools)
		expect(result).toBe(`WITHDRAW 400000000 from ${aave} tx 0x${'ab'.repeat(32)}`)
		const [, , p] = decodeReport(writes[0]?.report?.rawReport ?? new Uint8Array())
		expect(p.supply).toBe(false)
		expect(p.pool).toBe(getAddress(AAVE_POOL))
	})

	test('holds when the difference does not cover a round trip', async () => {
		const { result, writes } = await run(spread(4.6, 5), bothPools)
		expect(result).toBe('HOLD (already at the target split)')
		expect(writes).toHaveLength(0)
	})

	/**
	 * The bar a migration has to clear is twice the ordinary deadband, and it survives the clamp:
	 * the same 40 USDC ceiling lets an ordinary withdrawal through and refuses a migration, which
	 * is the whole point of carrying the round-trip number into the second check.
	 */
	test('the round-trip bar is what the clamped move is measured against', async () => {
		const capped = { ...secrets, [POLICY_SECRET_IDS.maxMoveAmount]: '40000000' }
		const hash = policyHash({
			targetWorkingBps: 8_000,
			minIdleAmount: usdc(100),
			minMoveAmount: usdc(25),
			minMoveBps: 50,
			minSupplyRateRay: 0n,
			maxMoveAmount: usdc(40),
			expiry: 2_000_000_000,
		})
		const migration = await run(
			spread(2, 5),
			{ ...bothPools, policyHash: hash },
			{ secrets: capped },
		)
		expect(migration.result).toBe('HOLD (the per-move ceiling leaves a move inside the deadband)')

		const rebalance = await run(
			two(
				usdc(10),
				{ supplied: usdc(500), rate: percent(2) },
				{ supplied: usdc(490), rate: percent(5) },
			),
			{ ...bothPools, policyHash: hash },
			{ secrets: capped },
		)
		expect(rebalance.result).toStartWith(`WITHDRAW 40000000 from ${aave}`)
	})

	/** One market cannot be both the source and the destination of a move between markets. */
	test('a single-market account never migrates', async () => {
		const { result } = await run(one(usdc(200), usdc(800)))
		expect(result).toBe('HOLD (already at the target split)')
	})
})

// ─── The Aqua buffer, from The Graph ─────────────────────────
/**
 * The buffer is sized by what this account's own Aqua mandates could still be asked to pay out of
 * its wallet, and that question has no on-chain answer: `_balances` is private and four levels
 * deep and none of Aqua's four events indexes a parameter. The index is the only place the number
 * exists — and every one of its failure modes has to leave the run with a decision that is worse
 * rather than wrong.
 */
describe('the Aqua buffer', () => {
	const SUBGRAPH =
		'https://api.studio.thegraph.com/query/1758877/helico-arbitrum-one/version/latest'
	const indexed: Partial<Config> = { subgraphUrl: SUBGRAPH }

	/** `tokensCount` 2 is Aqua's sentinel for a live two-token ship. */
	const balances = (...amounts: bigint[]) =>
		JSON.stringify({
			data: { balances: amounts.map((amount) => ({ amount: String(amount), tokensCount: 2 })) },
		})

	test('is not asked for at all when no endpoint is configured', async () => {
		const { result, graphRequests } = await run(allIdle)
		expect(graphRequests).toHaveLength(0)
		expect(result).toBe(`SUPPLY 800000000 to ${aave} tx 0x${'ab'.repeat(32)}`)
	})

	test('asks the index for this account’s live balances of the asset it manages', async () => {
		const { graphRequests } = await run(allIdle, indexed, { graphBody: balances() })
		expect(graphRequests).toHaveLength(1)
		const { variables } = graphRequests[0] as NonNullable<(typeof graphRequests)[0]>
		expect(variables).toEqual({
			maker: account.toLowerCase(),
			token: USDC.toLowerCase(),
			first: 1000,
		})
	})

	/**
	 * 1,000 USDC and a policy asking for 100 liquid would supply 800. Mandates that could demand
	 * 400 leave only 600 free to work, and the buffer is what changed — nothing else in the
	 * policy moved.
	 */
	test('raises the buffer to what the mandates could demand, and the move follows', async () => {
		const { result } = await run(allIdle, indexed, { graphBody: balances(usdc(250), usdc(150)) })
		expect(result).toStartWith(
			`SUPPLY 600000000 to ${aave} [buffer 400000000: policy floor 100000000, 2 live Aqua balances could demand 400000000]`,
		)
	})

	/** A demand larger than the account's idle side is what pulls capital back out of the market. */
	test('a mandate the account cannot cover turns a hold into a withdrawal', async () => {
		const settled = one(usdc(200), usdc(800))
		expect((await run(settled)).result).toBe('HOLD (already at the target split)')
		const { result } = await run(settled, indexed, { graphBody: balances(usdc(400)) })
		expect(result).toStartWith(`WITHDRAW 200000000 from ${aave} [buffer 400000000`)
	})

	/**
	 * The direction that must never happen. The owner's minimum is theirs; an index reporting less
	 * than it has nothing to say about a number they set themselves.
	 */
	test('never lowers the owner’s floor, however little the mandates demand', async () => {
		const { result } = await run(allIdle, indexed, { graphBody: balances(1n) })
		expect(result).toStartWith(
			`SUPPLY 800000000 to ${aave} [buffer 100000000: policy floor 100000000, 1 live Aqua balance could demand 1]`,
		)
	})

	/**
	 * The raised floor is not the owner's published policy and must never be hashed as if it were:
	 * a run with a live mandate would then look like a policy edited underneath the workflow, and
	 * every run would hold.
	 */
	test('the report still carries the hash the owner published, not one recomputed from the raised floor', async () => {
		const { result, writes } = await run(allIdle, indexed, { graphBody: balances(usdc(400)) })
		expect(result).not.toContain('policy hash mismatch')
		const [, hash] = decodeReport(writes[0]?.report?.rawReport ?? new Uint8Array())
		expect(hash).toBe(committedHash)
	})

	/** A mismatch stops before the chain, and before the index too — there is nothing to size. */
	test('a policy the owner did not publish stops before the index is asked', async () => {
		const { result, graphRequests } = await run(
			allIdle,
			{ ...indexed, policyHash: `0x${'ab'.repeat(32)}` },
			{ graphBody: balances(usdc(400)) },
		)
		expect(result).toBe('HOLD (policy hash mismatch)')
		expect(graphRequests).toHaveLength(0)
	})

	/**
	 * Every way the index can fail to answer, and the same outcome each time: the owner's own
	 * floor, the move the workflow would have made before the subgraph was in the loop, and a
	 * verdict that says which of the two buffers it used.
	 */
	test.each([
		['it cannot be reached', { graphThrows: true }, 'the subgraph could not be reached'],
		['it answers a bad status', { graphStatus: 502 }, 'the subgraph answered HTTP 502'],
		[
			'it answers 200 with errors, the way GraphQL refuses a query',
			{ graphBody: '{"errors":[{"message":"indexers not available"}]}' },
			'the subgraph answered indexers not available',
		],
		[
			'it answers something that is not JSON',
			{ graphBody: '<html>504 Gateway Time-out</html>' },
			'the subgraph answered something that is not JSON',
		],
	])('falls back to the policy floor when %s, and says so', async (_, faults, reason) => {
		const { result, writes } = await run(allIdle, indexed, faults)
		expect(result).toBe(
			`SUPPLY 800000000 to ${aave} [buffer 100000000: policy floor only, ${reason}] tx 0x${'ab'.repeat(32)}`,
		)
		// The fallback is a decision, not a hold: the run still moves capital.
		expect(writes).toHaveLength(1)
	})

	/**
	 * An empty answer and an absent one produce the same buffer and are reported differently on
	 * purpose. One is a fact about the maker — no live mandate in this asset — and the other is a
	 * fact about the index.
	 */
	test('an empty index is a fact about the maker, not a failure', async () => {
		const { result } = await run(allIdle, indexed, { graphBody: balances() })
		expect(result).toContain(
			'[buffer 100000000: policy floor 100000000, 0 live Aqua balances could demand 0]',
		)
	})

	/**
	 * An indexer behind the chain under-reports, so the buffer comes out too small and more
	 * capital is supplied than ideal. That degrades into the path the swap takes today —
	 * `HelicoMandateSwap._cover` unwinds inside the swap — rather than into a wrong move, which is
	 * why lag is survivable and why the floor may only ever be raised.
	 */
	test('an indexer that lags under-reports, which is the safe direction', async () => {
		const behind = await run(allIdle, indexed, { graphBody: balances(usdc(250)) })
		const current = await run(allIdle, indexed, { graphBody: balances(usdc(250), usdc(150)) })
		// The lagging run supplies 150 more than it should, which is 150 the next swap has to
		// unwind from Aave inside itself. Slower and refusable, but the existing path.
		expect(behind.result).toStartWith('SUPPLY 750000000')
		expect(current.result).toStartWith('SUPPLY 600000000')
	})

	/** A full page may be a prefix, and a sum over a prefix is a floor rather than the total. */
	test('a full page says so rather than passing a prefix off as the whole', async () => {
		const page = balances(...Array.from({ length: 1000 }, () => 1_000_000n))
		const { result } = await run(allIdle, indexed, { graphBody: page })
		expect(result).toContain('could demand 1000000000; a full page, so there may be more')
	})

	/**
	 * `rehearse-idle.sh` lifts the signed statement out of this line with a greedy match to the
	 * last `}`, so anything printed after the JSON would be swallowed into what it parses. The
	 * note goes in front, and this is the script's own regex run against the real output.
	 */
	test('the note never lands where the rehearsal reads the signed statement', async () => {
		const { result } = await run(
			{ ...allIdle, nonce: 7n },
			{ ...indexed, delivery: 'signature', chainId: 42_161 },
			{ secrets: { ...secrets, AGENT_KEY: agentKey }, graphBody: balances(usdc(400)) },
		)
		expect(result).toContain('[buffer 400000000')
		const lifted = result.match(/\{"params.*\}/)?.[0] as string
		expect(JSON.parse(lifted).params.amount).toBe('600000000')
	})
})

describe('signature delivery', () => {
	const signing: Partial<Config> = { delivery: 'signature', chainId: 42_161 }
	const withKey = { ...secrets, AGENT_KEY: agentKey }
	const chain: Chain = { ...allIdle, nonce: 7n }

	test('signs the move with the agent key and lets only the statement out', async () => {
		const { result, writes, reports, secretRequests } = await run(chain, signing, {
			secrets: withKey,
		})
		expect(secretRequests).toContain('AGENT_KEY')
		expect(result.startsWith(`SUPPLY 800000000 to ${aave} {`)).toBe(true)
		const auth = JSON.parse(result.slice(result.indexOf('{'))) as {
			params: Record<string, string | boolean>
			policyHash: Hex
			nonce: string
			signature: Hex
			signer: Address
			call: { to: Address; data: Hex }
		}
		expect(auth.signer).toBe(agent)
		expect(auth.nonce).toBe('7')
		expect(auth.policyHash).toBe(committedHash)
		// The call the relayer makes is in the statement, so there is nothing left to encode.
		expect(auth.call.to).toBe(config.account as Address)
		expect(auth.call.data.slice(0, 10)).toBe('0x853112a5')
		// No forwarder write; the DON report carries the statement and nothing else.
		expect(writes).toHaveLength(0)
		expect(reports).toHaveLength(1)
		const [p, hash, nonce, sig] = decodeAbiParameters(
			[idleMoveParamsAbi, { type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes' }],
			bytesToHex(Buffer.from(reports[0] ?? '', 'base64')),
		)
		expect(hash).toBe(committedHash)
		expect(nonce).toBe(7n)
		expect(sig).toBe(auth.signature)
		expect(p.amount).toBe(usdc(800))
		expect(p.supply).toBe(true)
		// The signature verifies against the account's own domain for exactly this move.
		const domain = {
			name: 'HelicoAccount',
			version: '1',
			chainId: 42_161,
			verifyingContract: config.account as Address,
		}
		expect(await recoverIdleMoveSigner(domain, { params: p, policyHash: hash, nonce }, sig)).toBe(
			agent,
		)
		// The key itself never crosses out.
		for (const leaked of [
			result,
			...reports,
			bytesToHex(Buffer.from(reports[0] ?? '', 'base64')),
		]) {
			expect(leaked.toLowerCase()).not.toContain(agentKey.slice(2))
		}
	})

	/** The market chosen is the one the statement is about, so a relayer cannot substitute one. */
	test('the statement names the market the enclave picked', async () => {
		const { result } = await run(
			{
				...two(usdc(1_000), { supplied: 0n, rate: percent(2) }, { supplied: 0n, rate: percent(5) }),
				nonce: 7n,
			},
			{ ...signing, ...bothPools },
			{ secrets: withKey },
		)
		const auth = JSON.parse(result.slice(result.indexOf('{'))) as {
			params: { pool: Address }
		}
		expect(auth.params.pool).toBe(OTHER_POOL as Address)
	})

	test('a hold signs nothing and asks for nothing more than the policy', async () => {
		const { result, reports, secretRequests } = await run(
			{ ...chain, venues: [{ pool: AAVE_POOL, supplied: 0n, permitted: false }] },
			signing,
			{ secrets: withKey },
		)
		expect(result).toBe('HOLD (the owner has not permitted this venue)')
		expect(reports).toHaveLength(0)
		expect(secretRequests).toContain('AGENT_KEY')
	})

	test('forwarder delivery never asks the Vault DON for the agent key', async () => {
		const { secretRequests } = await run(allIdle)
		expect(secretRequests).not.toContain('AGENT_KEY')
	})

	test('refuses to sign without the key', async () => {
		await expect(run(chain, signing)).rejects.toThrow('Secret AGENT_KEY is missing')
	})

	test('an account without a nonce fails loudly instead of signing against nothing', async () => {
		const noNonce = handlers(chain)
		noNonce[sel('function nonce()')] = () => {
			throw new RpcError('execution reverted')
		}
		const fake = fakeRuntime({
			config: configSchema.parse({ ...config, ...signing }),
			secrets: withKey,
			now,
			handlers: noNonce,
		})
		await expect(onCronTrigger(fake.runtime)).rejects.toThrow(
			'eth_call 6 failed: execution reverted',
		)
		expect(fake.reports).toHaveLength(0)
	})
})

describe('deliver', () => {
	const params = {
		account,
		pool: getAddress(AAVE_POOL),
		asset: getAddress(USDC),
		amount: usdc(800),
		supply: true,
		deadline: BigInt(now + 600),
	}

	test('encodes the tuple in its declared order: pinned to an encoding produced by cast', () => {
		// cast abi-encode "f(bool,bytes32,(address,address,address,uint256,bool,uint256))" \
		//   true 0x63252eb3…9584 "(0x7461…88C0,0x794a…14aD,0xaf88…5831,800000000,true,1700000600)"
		expect(encodeReport(true, committedHash, params)).toBe(
			'0x000000000000000000000000000000000000000000000000000000000000000163252eb3d00b4713a7ae923551b77107f12c2aa057b94494fda994b235499584000000000000000000000000746182d0cccc5cefc69853bb0325c850029388c0000000000000000000000000794a61358d6845594f94dc1db02a252b5b4814ad000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e5831000000000000000000000000000000000000000000000000000000002faf08000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000006553f358',
		)
	})

	test('signs the report through the DON and writes it to the receiver on the configured chain', () => {
		const fake = fakeRuntime({ config, secrets, now, handlers: {} })
		const txHash = deliver(
			fake.runtime.usingTheDons(),
			config,
			encodeReport(true, committedHash, params),
		)
		expect(txHash).toBe(`0x${'ab'.repeat(32)}`)
		expect(fake.writes).toHaveLength(1)
		const write = fake.writes[0] as NonNullable<(typeof fake.writes)[0]>
		expect(bytesToHex(write.receiver)).toBe(config.reportReceiver as Hex)
		// The bytes the DON signed are the bytes the receiver gets, and they decode as the tuple.
		expect(Buffer.from(fake.reports[0] ?? '', 'base64')).toEqual(
			Buffer.from(write.report?.rawReport ?? new Uint8Array()),
		)
		const [act, hash, p] = decodeReport(write.report?.rawReport ?? new Uint8Array())
		expect(act).toBe(true)
		expect(hash).toBe(committedHash)
		expect(p).toEqual(params)
		// Nothing else crossed out: no RPC traffic went through the DON.
		expect(fake.rpcRequests).toHaveLength(0)
	})

	/**
	 * `HelicoAccount` has no `onReport`, so there is nothing deployed to write to yet and the
	 * placeholder in both config files is zero. A write to an address with no code succeeds as a
	 * transaction and moves nothing, which in a log is indistinguishable from a move.
	 */
	test('refuses to write into the void when no receiver is deployed', () => {
		const fake = fakeRuntime({ config, secrets, now, handlers: {} })
		expect(() =>
			deliver(
				fake.runtime.usingTheDons(),
				{ ...config, reportReceiver: zeroAddress },
				encodeReport(true, committedHash, params),
			),
		).toThrow('No report receiver is deployed')
		expect(fake.writes).toHaveLength(0)
	})

	test('fails loudly when the write does not succeed', () => {
		const fake = fakeRuntime({ config, secrets, now, handlers: {}, writeStatus: 1 })
		expect(() =>
			deliver(fake.runtime.usingTheDons(), config, encodeReport(true, committedHash, params)),
		).toThrow('writeReport failed: REVERTED')
	})

	test('rejects a chain selector name the SDK does not know', () => {
		const nowhere = { ...config, chainSelectorName: 'nowhere' }
		const fake = fakeRuntime({ config: nowhere, secrets, now, handlers: {} })
		expect(() =>
			deliver(fake.runtime.usingTheDons(), nowhere, encodeReport(false, committedHash)),
		).toThrow('Unknown chain selector name')
	})
})

describe('encodeReport', () => {
	test('a hold encodes as act = false with zeroed params, so the layout never changes', () => {
		const [act, hash, p] = decodeAbiParameters(
			[{ type: 'bool' }, { type: 'bytes32' }, idleMoveParamsAbi],
			encodeReport(false, committedHash),
		)
		expect(act).toBe(false)
		expect(hash).toBe(committedHash)
		expect(p.account).toBe(zeroAddress)
		expect(p.supply).toBe(false)
		expect(encodeReport(false, committedHash).length).toBe(2 + 8 * 64)
	})
})

describe('initWorkflow', () => {
	test('registers the cron handler inside a Nitro enclave in us-west-2', () => {
		const [handler] = initWorkflow(config)
		expect(handler).toMatchObject({
			requirements: {
				tee: {
					item: {
						case: 'teeTypesAndRegions',
						value: { teeTypeAndRegions: [{ type: 1, regions: ['us-west-2'] }] },
					},
				},
			},
		})
	})
})
