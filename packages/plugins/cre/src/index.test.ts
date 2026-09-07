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
const account = getAddress('0x746182d0cccc5cefc69853bb0325c850029388c0')
// Anvil's first account. The enclave holds the key behind it in signature mode.
const agent = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const agentKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

/** USDC has six decimals, so every amount below is `whole * 1e6`. */
const usdc = (whole: number): bigint => BigInt(whole) * 1_000_000n
const RATE = 27_514_566_416_591_863_466_760_475n // 2.75%, the live USDC rate on the day

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
	schedule: '0 */5 * * * *',
	rpcUrl: 'https://arb1.arbitrum.io/rpc',
	delivery: 'forwarder',
	chainSelectorName: 'ethereum-mainnet-arbitrum-1',
	domainName: 'HelicoAccount',
	domainVersion: '1',
	agentKeySecretId: 'AGENT_KEY',
	nonceFunction: 'nonce',
	account: account.toLowerCase(),
	pool: AAVE_POOL.toLowerCase(),
	asset: USDC.toLowerCase(),
	agent: agent.toLowerCase(),
	reportReceiver: '0x3333333333333333333333333333333333333333',
	policyHash: committedHash,
	gasLimit: '1500000',
	deadlineSeconds: 600,
}
const now = 1_700_000_000

type Chain = {
	agent?: Address
	permitted?: boolean
	idle: bigint
	supplied: bigint
	receipt?: Address
	receiptAsset?: Address
	venueLiquidity?: bigint
	rate?: bigint
	nonce?: bigint
}

const sel = (sig: string): Hex => toFunctionSelector(sig)
const word = (x: bigint | number | boolean | string): Hex =>
	typeof x === 'string'
		? encodeAbiParameters([{ type: 'address' }], [x as Address])
		: encodeAbiParameters([{ type: 'uint256' }], [BigInt(x)])

/**
 * The reads the enclave makes, answered from one description of the chain. `balanceOf` is asked
 * of two different contracts, so it dispatches on the address rather than on the selector.
 */
const handlers = (c: Chain) => ({
	[sel('function agent()')]: () => word(c.agent ?? agent),
	[sel('function permittedVenue(address)')]: () => word(c.permitted ?? true),
	[sel('function nonce()')]: () => word(c.nonce ?? 0n),
	[sel('function getReserveAToken(address)')]: () => word(c.receipt ?? AUSDC),
	[sel('function getVirtualUnderlyingBalance(address)')]: () =>
		word(c.venueLiquidity ?? 29_318_183_885_841n),
	[sel('function UNDERLYING_ASSET_ADDRESS()')]: () => word(c.receiptAsset ?? USDC),
	[sel('function balanceOf(address)')]: (_: Hex, to: string) =>
		word(to.toLowerCase() === USDC.toLowerCase() ? c.idle : c.supplied),
	[sel('function getReserveData(address)')]: () =>
		encodeAbiParameters(
			parseAbiParameters(
				'(uint256, uint128, uint128, uint128, uint128, uint128, uint40, uint16, address, address, address, address, uint128, uint128, uint128)',
			),
			[
				[
					0n,
					10n ** 27n,
					c.rate ?? RATE,
					10n ** 27n,
					0n,
					0n,
					now,
					12,
					AUSDC,
					zeroAddress,
					zeroAddress,
					zeroAddress,
					0n,
					0n,
					0n,
				],
			],
		),
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
		[{ type: 'bool' }, { type: 'bytes32' }, idleMoveParamsAbi],
		bytesToHex(rawReport),
	)

/** 1,000 USDC sitting idle and nothing working: 800 of it should be at the market. */
const allIdle: Chain = { idle: usdc(1_000), supplied: 0n }

// ─── Tests ───────────────────────────────────────────────────
describe('configSchema', () => {
	test('carries no threshold: every one of them comes from a secret', () => {
		for (const key of Object.keys(POLICY_SECRET_IDS)) {
			expect(Object.keys(configShape)).not.toContain(key)
		}
	})

	test('lowercases hex values so a checksummed config compares equal to what the chain returns', () => {
		const parsed = configSchema.parse({ ...config, pool: AAVE_POOL, asset: USDC, agent })
		expect(parsed.pool).toBe(AAVE_POOL.toLowerCase())
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
			[account, account, USDC, AAVE_POOL, AAVE_POOL, AAVE_POOL].map(lower),
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
			{ ...allIdle, permitted: false },
			'HOLD (the owner has not permitted this venue)',
		],
		[
			'the market does not list the asset',
			{ ...allIdle, receipt: zeroAddress },
			'HOLD (the venue does not list this asset)',
		],
		[
			'the receipt is for a different asset',
			{ ...allIdle, receiptAsset: AAVE_POOL as Address },
			"HOLD (the venue's receipt is for a different asset)",
		],
		[
			'the account is empty',
			{ idle: 0n, supplied: 0n },
			'HOLD (the account holds nothing to place)',
		],
		[
			'the split is already met',
			{ idle: usdc(200), supplied: usdc(800) },
			'HOLD (already at the target split)',
		],
		[
			'the drift is smaller than the deadband',
			{ idle: usdc(210), supplied: usdc(800) },
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
		const { rpcRequests } = await run({ ...allIdle, receipt: zeroAddress })
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
		expect(result).toBe('HOLD (the venue pays below the policy floor)')
	})

	test('supplies the excess and delivers the move as a report', async () => {
		const { result, writes, reports } = await run(allIdle)
		expect(result).toBe(`SUPPLY 800000000 tx 0x${'ab'.repeat(32)}`)
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
		const { result, writes } = await run({ idle: usdc(10), supplied: usdc(990) })
		expect(result).toBe(`WITHDRAW 190000000 tx 0x${'ab'.repeat(32)}`)
		const [, , p] = decodeReport(writes[0]?.report?.rawReport ?? new Uint8Array())
		expect(p.supply).toBe(false)
		expect(p.amount).toBe(usdc(190))
	})

	/**
	 * The deadband is applied twice, and this is why. The split asked for 190 USDC, which clears
	 * it easily; a drained market leaves 3, which does not. Without the second check the run
	 * would pay gas to move three dollars because the market could not manage the rest.
	 */
	test('holds when the market can only return a fragment of what was wanted', async () => {
		const { result, writes } = await run({
			idle: usdc(10),
			supplied: usdc(990),
			venueLiquidity: usdc(3),
		})
		expect(result).toBe('HOLD (the venue liquidity leaves a move inside the deadband)')
		expect(writes).toHaveLength(0)
	})

	test('holds when the market can return nothing at all', async () => {
		const { result } = await run({ idle: usdc(10), supplied: usdc(990), venueLiquidity: 0n })
		expect(result).toBe('HOLD (the venue cannot return anything right now)')
	})

	test('a market that can only pay part of it still moves that part, when the part is worth moving', async () => {
		const { result } = await run({
			idle: usdc(10),
			supplied: usdc(990),
			venueLiquidity: usdc(120),
		})
		expect(result).toStartWith('WITHDRAW 120000000 tx')
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
		expect(result).toStartWith('SUPPLY 100000000 tx')
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

describe('signature delivery', () => {
	const signing: Partial<Config> = { delivery: 'signature', chainId: 42_161 }
	const withKey = { ...secrets, AGENT_KEY: agentKey }
	const chain: Chain = { ...allIdle, nonce: 7n }

	test('signs the move with the agent key and lets only the statement out', async () => {
		const { result, writes, reports, secretRequests } = await run(chain, signing, {
			secrets: withKey,
		})
		expect(secretRequests).toContain('AGENT_KEY')
		expect(result.startsWith('SUPPLY 800000000 {')).toBe(true)
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

	test('a hold signs nothing and asks for nothing more than the policy', async () => {
		const { result, reports, secretRequests } = await run({ ...chain, permitted: false }, signing, {
			secrets: withKey,
		})
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
