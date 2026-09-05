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
} from 'viem'
import {
	type Config,
	configSchema,
	deliver,
	encodeReport,
	initWorkflow,
	MANDATE_SECRET_IDS,
	mandateHash,
	onCronTrigger,
	recenterParamsAbi,
} from './index'
import { fakeRuntime } from './test/fakeRuntime'

// ─── Fixtures: the Robinhood testnet ETH/WETH pool at tick -65 ───────────────
const poolId = '0xea84630b1ccfd69145b791334c55a7d8be1565910cb6e290c489413c977fd9c5'
const poolKey = {
	currency0: '0x0000000000000000000000000000000000000000',
	currency1: '0x7943e237c7F95DA44E0301572D358911207852Fa',
	fee: 500,
	tickSpacing: 10,
	hooks: '0x0000000000000000000000000000000000000000',
} as const
const sqrtPriceX96 = 78_971_408_793_868_239_585_893_302_751n
const owner = getAddress('0x746182d0cccc5cefc69853bb0325c850029388c0')
const secrets = {
	[MANDATE_SECRET_IDS.rangeWidthTicks]: '1000',
	[MANDATE_SECRET_IDS.minImprovementBps]: '50',
	[MANDATE_SECRET_IDS.cooldownSeconds]: '3600',
	[MANDATE_SECRET_IDS.maxLiquidity]: '1000000000000000000',
	[MANDATE_SECRET_IDS.expiry]: '1800000000',
	[MANDATE_SECRET_IDS.minRetainedBps]: '9000',
}
const committedHash = mandateHash({
	poolId,
	rangeWidthTicks: 1000,
	minImprovementBps: 50,
	cooldownSeconds: 3600,
	maxLiquidity: 10n ** 18n,
	expiry: 1_800_000_000,
	minRetainedBps: 9000,
})
const config: Config = {
	schedule: '0 */5 * * * *',
	rpcUrl: 'https://rpc.testnet.chain.robinhood.com/rpc',
	chainSelectorName: 'robinhood-testnet',
	vault: '0x1111111111111111111111111111111111111111',
	positionManager: '0x58daec3116aae6D93017bAAea7749052E8a04fA7',
	stateView: '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b',
	owner,
	poolId,
	mandateHash: committedHash,
	gasLimit: '1500000',
	slippageBps: 50,
	deadlineSeconds: 600,
}
const now = 1_700_000_000

type Chain = {
	tokenId: bigint
	lastActionAt: bigint
	active: boolean
	tick: number
	liquidity: bigint
	range: [number, number]
}

const sel = (sig: string): Hex => toFunctionSelector(sig)
const u256 = (x: bigint | number | boolean): Hex =>
	encodeAbiParameters([{ type: 'uint256' }], [BigInt(x)])

/** The five reads the enclave makes, answered from one description of the chain. */
const handlers = (c: Chain) => ({
	[sel('function positionOf(address)')]: () => u256(c.tokenId),
	[sel('function lastActionAt(address)')]: () => u256(c.lastActionAt),
	[sel('function isActive(address)')]: () => u256(c.active),
	[sel('function getSlot0(bytes32)')]: () =>
		encodeAbiParameters(parseAbiParameters('uint160, int24, uint24, uint24'), [
			sqrtPriceX96,
			c.tick,
			0,
			500,
		]),
	[sel('function getPositionLiquidity(uint256)')]: () => u256(c.liquidity),
	[sel('function getPoolAndPositionInfo(uint256)')]: () =>
		encodeAbiParameters(parseAbiParameters('(address,address,uint24,int24,address), uint256'), [
			[poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
			((BigInt(c.range[1]) & 0xffffffn) << 32n) | ((BigInt(c.range[0]) & 0xffffffn) << 8n),
		]),
})

const run = (chain: Chain, overrides: Partial<Config> = {}, writeStatus?: number) => {
	const fake = fakeRuntime({
		config: { ...config, ...overrides },
		secrets,
		now,
		handlers: handlers(chain),
		writeStatus,
	})
	const result = onCronTrigger(fake.runtime)
	return { ...fake, result }
}

const decodeReport = (rawReport: Uint8Array) =>
	decodeAbiParameters(
		[{ type: 'bool' }, { type: 'bytes32' }, recenterParamsAbi],
		bytesToHex(rawReport),
	)

// In range but off-centre, so the burn returns both tokens and a centred range can be funded.
const offCentre: Chain = {
	tokenId: 7n,
	lastActionAt: 0n,
	active: true,
	tick: -65,
	liquidity: 10n ** 15n,
	range: [-1_000, 0],
}

// ─── Tests ───────────────────────────────────────────────────
describe('configSchema', () => {
	test('carries no threshold and no position: both are read from secrets and the vault', () => {
		expect(configSchema.parse(config)).toEqual(config)
		expect(Object.keys(configSchema.shape)).not.toContain('position')
		expect(Object.keys(configSchema.shape)).not.toContain('minImprovementBps')
	})
})

describe('onCronTrigger', () => {
	test('refuses, and never reads the chain, when the secrets do not match the committed hash', () => {
		const { result, rpcRequests, writes } = run(offCentre, { mandateHash: `0x${'ab'.repeat(32)}` })
		expect(result).toBe('HOLD (mandate hash mismatch)')
		expect(rpcRequests).toHaveLength(0)
		expect(writes).toHaveLength(0)
	})

	test('reads the account and the pool, then the position, in two batches from inside the enclave', () => {
		const { rpcRequests } = run({ ...offCentre, range: [-2_000, -1_000], tick: -65 })
		expect(rpcRequests).toHaveLength(2)
		expect(rpcRequests[0]?.map((r) => r.params[0].to)).toEqual([
			config.vault,
			config.vault,
			config.vault,
			config.stateView,
		])
		expect(rpcRequests[1]?.map((r) => r.params[0].to)).toEqual([
			config.positionManager,
			config.positionManager,
		])
		expect(rpcRequests[1]?.[0]?.params[0].data).toBe(
			`${sel('function getPositionLiquidity(uint256)')}${'0'.repeat(63)}7`,
		)
	})

	test.each([
		['a revoked mandate', { ...offCentre, active: false }, 'HOLD (mandate revoked)'],
		[
			'a position still in range',
			{ ...offCentre, range: [-560, 440] as [number, number] },
			'HOLD (in range)',
		],
		[
			'the cooldown',
			{ ...offCentre, range: [100, 1_100] as [number, number], lastActionAt: BigInt(now - 60) },
			'HOLD (cooldown)',
		],
		[
			'an empty position',
			{ ...offCentre, range: [100, 1_100] as [number, number], liquidity: 0n },
			'HOLD (vault would reject: NothingToMove)',
		],
		[
			'a position over the cap',
			{ ...offCentre, range: [100, 1_100] as [number, number], liquidity: 10n ** 19n },
			'HOLD (vault would reject: LiquidityTooLarge)',
		],
		[
			'an out-of-range position, which holds one token and cannot fund a two-sided range',
			{ ...offCentre, range: [100, 1_100] as [number, number] },
			'HOLD (the burn cannot fund the new range without a swap)',
		],
	])('holds on %s without writing anything', (_, chain, expected) => {
		const { result, writes } = run(chain)
		expect(result).toBe(expected)
		expect(writes).toHaveLength(0)
	})

	test('an in-range but off-centre position: this needs a policy change to act, so it holds today', () => {
		expect(run(offCentre).result).toBe('HOLD (in range)')
	})

	test('an out-of-range position always holds today: one token cannot fund a two-sided range', () => {
		for (const range of [
			[-1_000, -70],
			[100, 1_100],
		] as [number, number][]) {
			const { result, writes } = run({ ...offCentre, range })
			expect(result).toBe('HOLD (the burn cannot fund the new range without a swap)')
			expect(writes).toHaveLength(0)
		}
	})
})

describe('deliver', () => {
	const params = {
		owner,
		tickLower: -560,
		tickUpper: 440,
		liquidityToMint: 129_997_405_203_692n,
		amount0Min: 3_234_967_638_235n,
		amount1Min: 45_299_872_474_506n,
		amount0Max: 3_251_223_757_021n,
		amount1Max: 45_527_510_024_630n,
		deadline: BigInt(now + 600),
	}

	test('signs the report through the DON and writes it to the vault on the configured chain', () => {
		const fake = fakeRuntime({ config, secrets, now, handlers: {} })
		const txHash = deliver(
			fake.runtime.usingTheDons(),
			config,
			encodeReport(true, committedHash, params),
		)
		expect(txHash).toBe(`0x${'ab'.repeat(32)}`)
		expect(fake.writes).toHaveLength(1)
		const write = fake.writes[0] as NonNullable<(typeof fake.writes)[0]>
		expect(bytesToHex(write.receiver)).toBe(config.vault.toLowerCase())
		expect(write.gasConfig?.gasLimit).toBe(1_500_000n)
		// The bytes the DON signed are the bytes the vault receives, and they decode as its own struct.
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

	test('fails loudly when the write does not succeed', () => {
		const fake = fakeRuntime({ config, secrets, now, handlers: {}, writeStatus: 1 })
		expect(() =>
			deliver(fake.runtime.usingTheDons(), config, encodeReport(true, committedHash, params)),
		).toThrow('writeReport failed: REVERTED')
	})

	test('rejects a chain selector name the SDK does not know', () => {
		const fake = fakeRuntime({
			config: { ...config, chainSelectorName: 'nowhere' },
			secrets,
			now,
			handlers: {},
		})
		expect(() =>
			deliver(
				fake.runtime.usingTheDons(),
				{ ...config, chainSelectorName: 'nowhere' },
				encodeReport(false, committedHash),
			),
		).toThrow('Unknown chain selector name')
	})
})

describe('encodeReport', () => {
	test('a hold encodes as act = false with zeroed params, so the layout never changes', () => {
		const [act, hash, p] = decodeAbiParameters(
			[{ type: 'bool' }, { type: 'bytes32' }, recenterParamsAbi],
			encodeReport(false, committedHash),
		)
		expect(act).toBe(false)
		expect(hash).toBe(committedHash)
		expect(p.owner).toBe('0x0000000000000000000000000000000000000000' as Address)
		expect(encodeReport(false, committedHash).length).toBe(2 + 11 * 64)
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
