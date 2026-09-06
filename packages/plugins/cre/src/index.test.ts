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
	configShape,
	deliver,
	encodeReport,
	initWorkflow,
	MANDATE_SECRET_IDS,
	mandateHash,
	onCronTrigger,
	recenterParamsAbi,
	recoverRecentreSigner,
} from './index'
import { fakeRuntime, RpcError } from './test/fakeRuntime'

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
	// The explanation is off by default in these tests: an empty `aiUrl` means the workflow
	// asks for no AI secrets and calls no model, so every assertion below is about the decision
	// rather than about prose. `ai.test.ts` covers the other path.
	aiUrl: '',
	aiModel: 'ag/claude-opus-4-6-thinking',
	aiFallbackModel: 'ag/gemini-3-flash',
	aiMaxTokens: 1200,
	aiTimeoutSeconds: 30,
	schedule: '0 */5 * * * *',
	rpcUrl: 'https://rpc.testnet.chain.robinhood.com/rpc',
	delivery: 'forwarder',
	chainSelectorName: 'robinhood-testnet',
	domainName: 'HelicoVault',
	domainVersion: '1',
	agentKeySecretId: 'AGENT_KEY',
	noncesFunction: 'nonces',
	vault: '0x1111111111111111111111111111111111111111',
	positionManager: '0x58daec3116aae6D93017bAAea7749052E8a04fA7',
	stateView: '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b',
	owner,
	poolId,
	mandateHash: committedHash,
	gasLimit: '1500000',
	slippageBps: 50,
	maxPoolFeePips: 10_000,
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
	poolLiquidity?: bigint
	lpFee?: number
	poolKeyOverride?: Partial<typeof poolKey>
	nonce?: bigint
}

const sel = (sig: string): Hex => toFunctionSelector(sig)
const u256 = (x: bigint | number | boolean): Hex =>
	encodeAbiParameters([{ type: 'uint256' }], [BigInt(x)])

/** The five reads the enclave makes, answered from one description of the chain. */
const handlers = (c: Chain) => ({
	[sel('function positionOf(address)')]: () => u256(c.tokenId),
	[sel('function lastActionAt(address)')]: () => u256(c.lastActionAt),
	[sel('function isActive(address)')]: () => u256(c.active),
	[sel('function nonces(address)')]: () => u256(c.nonce ?? 0n),
	[sel('function getSlot0(bytes32)')]: () =>
		encodeAbiParameters(parseAbiParameters('uint160, int24, uint24, uint24'), [
			sqrtPriceX96,
			c.tick,
			0,
			c.lpFee ?? 500,
		]),
	[sel('function getLiquidity(bytes32)')]: () => u256(c.poolLiquidity ?? 0n),
	[sel('function getPositionLiquidity(uint256)')]: () => u256(c.liquidity),
	[sel('function getPoolAndPositionInfo(uint256)')]: () =>
		encodeAbiParameters(parseAbiParameters('(address,address,uint24,int24,address), uint256'), [
			[
				c.poolKeyOverride?.currency0 ?? poolKey.currency0,
				c.poolKeyOverride?.currency1 ?? poolKey.currency1,
				c.poolKeyOverride?.fee ?? poolKey.fee,
				c.poolKeyOverride?.tickSpacing ?? poolKey.tickSpacing,
				c.poolKeyOverride?.hooks ?? poolKey.hooks,
			],
			((BigInt(c.range[1]) & 0xffffffn) << 32n) | ((BigInt(c.range[0]) & 0xffffffn) << 8n),
		]),
})

type Faults = {
	writeStatus?: number
	httpStatus?: number
	rpcBody?: string
	secrets?: Record<string, string>
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
	})
	const result = await onCronTrigger(fake.runtime)
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
	test('carries no threshold and no position: both are read from secrets and the vault', async () => {
		for (const key of ['position', 'tickSpacing', 'minImprovementBps', 'minRetainedBps']) {
			expect(Object.keys(configShape)).not.toContain(key)
		}
	})

	test('lowercases hex values so a checksummed config compares equal to keccak output', async () => {
		const parsed = configSchema.parse({
			...config,
			poolId: poolId.toUpperCase().replace('0X', '0x'),
		})
		expect(parsed.poolId).toBe(poolId)
		expect(parsed.vault).toBe(config.vault.toLowerCase())
	})
})

describe('onCronTrigger', () => {
	test('refuses, and never reads the chain, when the secrets do not match the committed hash', async () => {
		const { result, rpcRequests, writes } = await run(offCentre, {
			mandateHash: `0x${'ab'.repeat(32)}`,
		})
		expect(result).toBe('HOLD (mandate hash mismatch)')
		expect(rpcRequests).toHaveLength(0)
		expect(writes).toHaveLength(0)
	})

	test('reads the account and the pool, then the position, in two batches from inside the enclave', async () => {
		const { rpcRequests } = await run({ ...offCentre, range: [-2_000, -1_000], tick: -65 })
		expect(rpcRequests).toHaveLength(2)
		const lower = (a: string) => a.toLowerCase()
		expect(rpcRequests[0]?.map((r) => r.params[0].to)).toEqual(
			[config.vault, config.vault, config.vault, config.stateView, config.stateView].map(lower),
		)
		expect(rpcRequests[1]?.map((r) => r.params[0].to)).toEqual(
			[config.positionManager, config.positionManager].map(lower),
		)
		expect(rpcRequests[1]?.[0]?.params[0].data).toBe(
			`${sel('function getPositionLiquidity(uint256)')}${'0'.repeat(63)}7`,
		)
	})

	// Out of range below, with a pool deep enough to swap into a two-sided range.
	const belowRange: Chain = { ...offCentre, range: [100, 1_100], poolLiquidity: 10n ** 18n }

	test.each([
		['a revoked mandate', { ...offCentre, active: false }, 'HOLD (mandate revoked)'],
		[
			'a position still in range',
			{ ...offCentre, range: [-560, 440] as [number, number] },
			'HOLD (in range)',
		],
		['the cooldown', { ...belowRange, lastActionAt: BigInt(now - 60) }, 'HOLD (cooldown)'],
		[
			'an empty position',
			{ ...belowRange, liquidity: 0n },
			'HOLD (vault would reject: NothingToMove)',
		],
		[
			'a position over the cap',
			{ ...belowRange, liquidity: 10n ** 19n },
			'HOLD (vault would reject: LiquidityTooLarge)',
		],
		[
			'a pool whose fee is above the enclave ceiling',
			{ ...belowRange, lpFee: 200_000 },
			'HOLD (pool fee above the enclave ceiling)',
		],
		[
			'a position in a pool other than the mandated one',
			{ ...belowRange, poolKeyOverride: { fee: 3_000 } },
			'HOLD (position is not in the mandated pool)',
		],
		[
			'an out-of-range position in a pool with no liquidity to swap against',
			{ ...offCentre, range: [100, 1_100] as [number, number] },
			'HOLD (vault would reject: NothingToMint)',
		],
	] as [string, Chain, string][])(
		'holds on %s without writing anything',
		async (_, chain, expected) => {
			const { result, writes } = await run(chain)
			expect(result).toBe(expected)
			expect(writes).toHaveLength(0)
		},
	)

	test('a retention floor of zero does not let a zero mint through', async () => {
		const zeroFloor = { ...secrets, [MANDATE_SECRET_IDS.minRetainedBps]: '0' }
		const hash = mandateHash({
			poolId,
			rangeWidthTicks: 1000,
			minImprovementBps: 50,
			cooldownSeconds: 3600,
			maxLiquidity: 10n ** 18n,
			expiry: 1_800_000_000,
			minRetainedBps: 0,
		})
		const { result, writes } = await run(
			{ ...offCentre, range: [100, 1_100] },
			{ mandateHash: hash },
			{ secrets: zeroFloor },
		)
		expect(result).toBe('HOLD (vault would reject: NothingToMint)')
		expect(writes).toHaveLength(0)
	})

	test('holds below the retention floor rather than shrinking the position', async () => {
		const strict = { ...secrets, [MANDATE_SECRET_IDS.minRetainedBps]: '9999' }
		const hash = mandateHash({
			poolId,
			rangeWidthTicks: 1000,
			minImprovementBps: 50,
			cooldownSeconds: 3600,
			maxLiquidity: 10n ** 18n,
			expiry: 1_800_000_000,
			minRetainedBps: 9999,
		})
		const { result, writes } = await run(belowRange, { mandateHash: hash }, { secrets: strict })
		expect(result).toBe("HOLD (below the mandate's retention floor)")
		expect(writes).toHaveLength(0)
	})

	test('re-centres an out-of-range position by swapping through the pool and delivers the sized params', async () => {
		const { result, writes, reports } = await run(belowRange)
		expect(result).toBe(`RECENTER -560..440 tx 0x${'ab'.repeat(32)}`)
		expect(writes).toHaveLength(1)
		const write = writes[0] as NonNullable<(typeof writes)[0]>
		expect(bytesToHex(write.receiver)).toBe(config.vault.toLowerCase() as Hex)
		expect(write.gasConfig?.gasLimit).toBe(1_500_000n)
		const [act, hash, p] = decodeReport(write.report?.rawReport ?? new Uint8Array())
		expect(act).toBe(true)
		expect(hash).toBe(committedHash)
		expect(p.owner).toBe(owner)
		expect([p.tickLower, p.tickUpper]).toEqual([-560, 440])
		// Below its range the position is all token0, so the swap sells token0.
		expect(p.zeroForOne).toBe(true)
		expect(p.amountIn).toBeGreaterThan(0n)
		expect(p.amountIn).toBeLessThan(p.amount0Min)
		expect(p.minAmountOut).toBeGreaterThan(0n)
		expect(p.liquidityToMint).toBeGreaterThan(0n)
		expect(p.liquidityToMint).toBeLessThan(belowRange.liquidity)
		// The floors are the burn's, the ceilings are what is held after the swap.
		expect(p.amount0Max).toBeLessThan(p.amount0Min)
		expect(p.amount1Min).toBe(0n)
		expect(p.amount1Max).toBeGreaterThan(0n)
		expect(p.deadline).toBe(BigInt(now + 600))
		expect(reports).toHaveLength(1)
	})

	test('above its range the position is all token1, so the swap sells token1', async () => {
		const { result, writes } = await run({
			...offCentre,
			range: [-2_000, -1_000],
			poolLiquidity: 10n ** 18n,
		})
		expect(result).toBe(`RECENTER -560..440 tx 0x${'ab'.repeat(32)}`)
		const [, , p] = decodeReport(writes[0]?.report?.rawReport ?? new Uint8Array())
		expect(p.zeroForOne).toBe(false)
		expect(p.amount0Min).toBe(0n)
		expect(p.amountIn).toBeLessThan(p.amount1Min)
	})

	test('the cooldown ends exactly at lastActionAt + cooldownSeconds, as in the vault', async () => {
		expect((await run({ ...belowRange, lastActionAt: BigInt(now - 3_600) })).result).toStartWith(
			'RECENTER',
		)
		expect((await run({ ...belowRange, lastActionAt: BigInt(now - 3_599) })).result).toBe(
			'HOLD (cooldown)',
		)
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
		await expect(run(belowRange, {}, faults)).rejects.toThrow(message)
	})
})

describe('signature delivery', () => {
	// Anvil's first account, a public test key; the fake hands it out as the AGENT_KEY secret.
	const agentKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
	const agentAddress = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
	const signing: Partial<Config> = { delivery: 'signature', chainId: 46630 }
	const withKey = { ...secrets, AGENT_KEY: agentKey }
	const belowRange: Chain = { ...offCentre, range: [100, 1_100], poolLiquidity: 10n ** 18n }
	const chain: Chain = { ...belowRange, nonce: 7n }

	test('signs the sized params with the agent key and lets only the authorisation out', async () => {
		const { result, writes, reports, secretRequests } = await run(chain, signing, {
			secrets: withKey,
		})
		expect(secretRequests).toContain('AGENT_KEY')
		expect(result.startsWith('RECENTER -560..440 {')).toBe(true)
		const auth = JSON.parse(result.slice(result.indexOf('{'))) as {
			params: Record<string, string | number | boolean>
			mandateHash: Hex
			nonce: string
			signature: Hex
			signer: Address
		}
		expect(auth.signer).toBe(agentAddress)
		expect(auth.nonce).toBe('7')
		expect(auth.mandateHash).toBe(committedHash)
		// No forwarder write; the DON report carries the authorisation and nothing else.
		expect(writes).toHaveLength(0)
		expect(reports).toHaveLength(1)
		const [p, hash, nonce, sig] = decodeAbiParameters(
			[recenterParamsAbi, { type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes' }],
			bytesToHex(Buffer.from(reports[0] ?? '', 'base64')),
		)
		expect(hash).toBe(committedHash)
		expect(nonce).toBe(7n)
		expect(sig).toBe(auth.signature)
		expect([p.tickLower, p.tickUpper]).toEqual([-560, 440])
		// The signature verifies against the vault's domain for exactly these params.
		const domain = {
			name: 'HelicoVault',
			version: '1',
			chainId: 46630,
			verifyingContract: config.vault as Address,
		}
		expect(await recoverRecentreSigner(domain, { params: p, mandateHash: hash, nonce }, sig)).toBe(
			agentAddress,
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

	test('a hold signs nothing and asks for nothing more than the mandate', async () => {
		const { result, reports, secretRequests } = await run({ ...chain, active: false }, signing, {
			secrets: withKey,
		})
		expect(result).toBe('HOLD (mandate revoked)')
		expect(reports).toHaveLength(0)
		expect(secretRequests).toContain('AGENT_KEY')
	})

	test('forwarder delivery never asks the Vault DON for the agent key', async () => {
		const { secretRequests } = await run(belowRange)
		expect(secretRequests).not.toContain('AGENT_KEY')
	})

	test('refuses to sign without the key', async () => {
		await expect(run(chain, signing)).rejects.toThrow('Secret AGENT_KEY is missing')
	})

	test('a vault without nonces fails loudly instead of signing against nothing', async () => {
		const noNonces = handlers(chain)
		noNonces[sel('function nonces(address)')] = () => {
			throw new RpcError('execution reverted')
		}
		const fake = fakeRuntime({
			config: configSchema.parse({ ...config, ...signing }),
			secrets: withKey,
			now,
			handlers: noNonces,
		})
		await expect(onCronTrigger(fake.runtime)).rejects.toThrow(
			'eth_call 5 failed: execution reverted',
		)
		expect(fake.reports).toHaveLength(0)
	})

	test('the schema ties chainId to signature delivery and chainSelectorName to the forwarder', () => {
		expect(() => configSchema.parse({ ...config, delivery: 'signature' })).toThrow('chainId')
		expect(() => configSchema.parse({ ...config, chainSelectorName: undefined })).toThrow(
			'chainSelectorName',
		)
		expect(configSchema.parse({ ...config, ...signing }).delivery).toBe('signature')
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
		zeroForOne: true,
		amountIn: 1_000_000_000_000n,
		minAmountOut: 995_000_000_000n,
		deadline: BigInt(now + 600),
	}

	test("encodes the tuple in the vault's field order: pinned to an encoding produced by cast", async () => {
		// cast abi-encode "f(bool,bytes32,(address,int24,int24,uint256,uint128,uint128,uint128,uint128,bool,uint256,uint256,uint256))" \
		//   true 0x134be6bb…6225 "(0x7461…88C0,-560,440,129997405203692,3234967638235,45299872474506,3251223757021,45527510024630,true,1000000000000,995000000000,1700000600)"
		expect(encodeReport(true, committedHash, params)).toBe(
			'0x0000000000000000000000000000000000000000000000000000000000000001134be6bb4e1c442551c22dfe96cb5b7c3c31babb386e2e9a051e57ee329a6225000000000000000000000000746182d0cccc5cefc69853bb0325c850029388c0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffdd000000000000000000000000000000000000000000000000000000000000001b80000000000000000000000000000000000000000000000000000763b6128acec000000000000000000000000000000000000000000000000000002f13318d0db0000000000000000000000000000000000000000000000000000293332cea58a000000000000000000000000000000000000000000000000000002f4fc0980dd00000000000000000000000000000000000000000000000000002968331001b60000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000e8d4a51000000000000000000000000000000000000000000000000000000000e7aa9f1e00000000000000000000000000000000000000000000000000000000006553f358',
		)
	})

	test('signs the report through the DON and writes it to the vault on the configured chain', async () => {
		const fake = fakeRuntime({ config, secrets, now, handlers: {} })
		const txHash = deliver(
			fake.runtime.usingTheDons(),
			config,
			encodeReport(true, committedHash, params),
		)
		expect(txHash).toBe(`0x${'ab'.repeat(32)}`)
		expect(fake.writes).toHaveLength(1)
		const write = fake.writes[0] as NonNullable<(typeof fake.writes)[0]>
		expect(bytesToHex(write.receiver)).toBe(config.vault.toLowerCase() as Hex)
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

	test('fails loudly when the write does not succeed', async () => {
		const fake = fakeRuntime({ config, secrets, now, handlers: {}, writeStatus: 1 })
		expect(() =>
			deliver(fake.runtime.usingTheDons(), config, encodeReport(true, committedHash, params)),
		).toThrow('writeReport failed: REVERTED')
	})

	test('rejects a chain selector name the SDK does not know', async () => {
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
	test('a hold encodes as act = false with zeroed params, so the layout never changes', async () => {
		const [act, hash, p] = decodeAbiParameters(
			[{ type: 'bool' }, { type: 'bytes32' }, recenterParamsAbi],
			encodeReport(false, committedHash),
		)
		expect(act).toBe(false)
		expect(hash).toBe(committedHash)
		expect(p.owner).toBe('0x0000000000000000000000000000000000000000' as Address)
		expect(encodeReport(false, committedHash).length).toBe(2 + 14 * 64)
	})
})

describe('initWorkflow', () => {
	test('registers the cron handler inside a Nitro enclave in us-west-2', async () => {
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
