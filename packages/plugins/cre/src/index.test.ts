import { describe, expect, test } from 'bun:test'
import type { TeeRuntime } from '@chainlink/cre-sdk'
import {
	bytesToHex,
	decodeAbiParameters,
	encodeAbiParameters,
	type Hex,
	parseAbiParameters,
} from 'viem'
import {
	type Config,
	configSchema,
	initWorkflow,
	MANDATE_SECRET_IDS,
	mandateHash,
	onCronTrigger,
} from './index'

// ─── Fixtures ────────────────────────────────────────────────
const poolId = '0xea84630b1ccfd69145b791334c55a7d8be1565910cb6e290c489413c977fd9c5'
const secretValues = {
	[MANDATE_SECRET_IDS.rangeWidthTicks]: '1000',
	[MANDATE_SECRET_IDS.minImprovementBps]: '50',
	[MANDATE_SECRET_IDS.cooldownSeconds]: '3600',
	[MANDATE_SECRET_IDS.maxLiquidity]: '1000000000000000000',
	[MANDATE_SECRET_IDS.expiry]: '1800000000',
}
const committedHash = mandateHash({
	poolId,
	rangeWidthTicks: 1000,
	minImprovementBps: 50,
	cooldownSeconds: 3600,
	maxLiquidity: 10n ** 18n,
	expiry: 1_800_000_000,
})
const config: Config = {
	schedule: '0 */5 * * * *',
	rpcUrl: 'https://rpc.testnet.chain.robinhood.com/rpc',
	stateView: '0xF3334192D15450CDd385C8B70e03F9a6bD9e673b',
	poolId,
	tickSpacing: 10,
	position: { tickLower: 100, tickUpper: 1100, lastActionAt: 0 },
	mandateHash: committedHash,
}

/** What StateView.getSlot0 returns for a pool sitting at `tick`. */
const slot0 = (tick: number): Hex =>
	encodeAbiParameters(parseAbiParameters('uint160, int24, uint24, uint24'), [
		79_228_162_514_264_337_593_543_950_336n,
		tick,
		0,
		500,
	])

const base64ToHex = (b64: string): Hex => bytesToHex(Buffer.from(b64, 'base64'))

type Report = {
	encodedPayload: string
	encoderName: string
	signingAlgo: string
	hashingAlgo: string
}

/** A TeeRuntime that records what leaves the enclave and what the enclave asked for. */
const fakeRuntime = (tick: number, overrides: Partial<Config> = {}) => {
	const reports: Report[] = []
	const httpRequests: { url: string; body: string }[] = []
	const runtime = {
		config: { ...config, ...overrides },
		now: () => new Date(1_700_000_000 * 1000),
		log: () => {},
		getSecrets: (requests: { id: string }[]) => ({
			result: () =>
				Object.fromEntries(
					requests.map((r) => [
						r.id,
						{ id: r.id, namespace: 'main', value: secretValues[r.id] ?? '' },
					]),
				),
		}),
		callCapability: ({ payload }: { payload: { url: string; body: string } }) => {
			httpRequests.push({ url: payload.url, body: Buffer.from(payload.body, 'base64').toString() })
			return {
				result: () => ({
					statusCode: 200,
					body: new TextEncoder().encode(
						JSON.stringify({ jsonrpc: '2.0', id: 1, result: slot0(tick) }),
					),
				}),
			}
		},
		usingTheDons: () => ({
			report: (input: Report) => {
				reports.push(input)
				return { result: () => ({}) }
			},
		}),
	}
	return { runtime: runtime as unknown as TeeRuntime<Config>, reports, httpRequests }
}

const decodeReport = (r: Report) =>
	decodeAbiParameters(
		parseAbiParameters('bool act, int24 tickLower, int24 tickUpper, bytes32 mandateHash'),
		base64ToHex(r.encodedPayload),
	)

// ─── Tests ───────────────────────────────────────────────────
describe('configSchema', () => {
	test('accepts the shape the enclave needs and nothing secret', () => {
		expect(configSchema.parse(config)).toEqual(config)
		expect(Object.keys(configSchema.shape)).not.toContain('minImprovementBps')
		expect(() => configSchema.parse({ ...config, mandateHash: '0x1234' })).toThrow()
	})
})

describe('onCronTrigger', () => {
	test('reads the tick through eth_call from inside the enclave', () => {
		const { runtime, httpRequests } = fakeRuntime(1_500)
		onCronTrigger(runtime)
		expect(httpRequests).toHaveLength(1)
		expect(httpRequests[0]?.url).toBe(config.rpcUrl)
		const rpc = JSON.parse(httpRequests[0]?.body ?? '{}') as {
			method: string
			params: [{ to: string; data: string }]
		}
		expect(rpc.method).toBe('eth_call')
		expect(rpc.params[0].to).toBe(config.stateView)
		expect(rpc.params[0].data).toBe(`0xc815641c${poolId.slice(2)}`)
	})

	test('reports a re-centre with only the verdict and the mandate hash crossing out', () => {
		const { runtime, reports } = fakeRuntime(1_500)
		expect(onCronTrigger(runtime)).toBe('RECENTER 1000..2000')
		expect(reports).toHaveLength(1)
		expect(reports[0]).toMatchObject({
			encoderName: 'evm',
			signingAlgo: 'ecdsa',
			hashingAlgo: 'keccak256',
		})
		expect(decodeReport(reports[0] as Report)).toEqual([true, 1_000, 2_000, committedHash])
		// Four ABI words, nothing else: the thresholds and the tick are not in the payload.
		expect(base64ToHex(reports[0]?.encodedPayload ?? '').length).toBe(2 + 4 * 64)
	})

	test('handles a negative tick: the Robinhood testnet pool at tick -65 re-centres to -560..440', () => {
		const { runtime, reports } = fakeRuntime(-65)
		expect(onCronTrigger(runtime)).toBe('RECENTER -560..440')
		expect(decodeReport(reports[0] as Report)).toEqual([true, -560, 440, committedHash])
	})

	test('reports a hold when the position is still in range', () => {
		const { runtime, reports } = fakeRuntime(600)
		expect(onCronTrigger(runtime)).toBe('HOLD (in range)')
		expect(decodeReport(reports[0] as Report)).toEqual([false, 0, 0, committedHash])
	})

	test('refuses to act, and never reads the chain, when the secrets do not match the committed hash', () => {
		const tampered = `0x${'ab'.repeat(32)}` as const
		const { runtime, reports, httpRequests } = fakeRuntime(1_500, { mandateHash: tampered })
		expect(onCronTrigger(runtime)).toBe('HOLD (mandate hash mismatch)')
		expect(httpRequests).toHaveLength(0)
		// The report carries the hash the enclave actually computed, so the vault sees the mismatch too.
		expect(decodeReport(reports[0] as Report)).toEqual([false, 0, 0, committedHash])
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
