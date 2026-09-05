import { bytesToBase64, cre, hexToBase64, ok, type TeeRuntime, text } from '@chainlink/cre-sdk'
import {
	type AbiParameter,
	decodeFunctionResult,
	encodeAbiParameters,
	encodeFunctionData,
	type Hex,
	parseAbi,
} from 'viem'
import { z } from 'zod'
import { decideRecentre, type Verdict } from './decision'
import { MANDATE_SECRET_IDS, mandateFromSecrets, mandateHash } from './mandate'

export * from './decision'
export * from './mandate'

const hex = (bytes: number) => z.string().regex(new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`))

// ─── Public config ───────────────────────────────────────────
// Everything here is visible to node operators; the thresholds are not here on purpose.
// No `.url()`: zod backs it with `new URL()`, which the WASM runtime does not provide.
export const configSchema = z.object({
	schedule: z.string(),
	/** JSON-RPC endpoint the enclave reads the pool from; any chain with a v4 StateView. */
	rpcUrl: z.string().regex(/^https?:\/\/\S+$/),
	stateView: hex(20),
	poolId: hex(32),
	tickSpacing: z.number().int().positive(),
	position: z.object({
		tickLower: z.number().int(),
		tickUpper: z.number().int(),
		lastActionAt: z.number().int().nonnegative(),
	}),
	/** `keccak256(abi.encode(mandate))` as committed in the vault. */
	mandateHash: hex(32),
})
export type Config = z.infer<typeof configSchema>

const stateViewAbi = parseAbi([
	'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
])

/** `StateView.getSlot0` through `eth_call`, made from inside the enclave so the read stays confidential. */
const readTick = (runtime: TeeRuntime<Config>): number => {
	const { rpcUrl, stateView, poolId } = runtime.config
	const call = {
		to: stateView,
		data: encodeFunctionData({
			abi: stateViewAbi,
			functionName: 'getSlot0',
			args: [poolId as Hex],
		}),
	}
	const body = JSON.stringify({
		jsonrpc: '2.0',
		id: 1,
		method: 'eth_call',
		params: [call, 'latest'],
	})
	const response = new cre.capabilities.HTTPClient()
		.sendRequest(runtime, {
			url: rpcUrl,
			method: 'POST',
			body: bytesToBase64(new TextEncoder().encode(body)),
			multiHeaders: { 'Content-Type': { values: ['application/json'] } },
		})
		.result()
	if (!ok(response)) throw new Error(`RPC returned status ${response.statusCode}`)
	const parsed = JSON.parse(text(response)) as { result?: Hex; error?: { message?: string } }
	if (!parsed.result) throw new Error(`eth_call failed: ${parsed.error?.message ?? 'no result'}`)
	const [, tick] = decodeFunctionResult({
		abi: stateViewAbi,
		functionName: 'getSlot0',
		data: parsed.result,
	})
	return tick
}

// Loosely typed on purpose: the ticks go in as BigInt. Under the WASM runtime (QuickJS) viem's
// Number-vs-BigInt range check rejects a negative int24 given as a Number; a BigInt is compared correctly.
const VERDICT_ABI: AbiParameter[] = [
	{ type: 'bool' },
	{ type: 'int24' },
	{ type: 'int24' },
	{ type: 'bytes32' },
]

/** The only thing that crosses back to the DON: what to do, where, and against which mandate. */
export const encodeVerdict = (verdict: Verdict, hash: Hex): Hex =>
	encodeAbiParameters(
		VERDICT_ABI,
		verdict.act
			? [true, BigInt(verdict.tickLower), BigInt(verdict.tickUpper), hash]
			: [false, 0n, 0n, hash],
	)

// ─── TEE cron callback ───────────────────────────────────────
export const onCronTrigger = (runtime: TeeRuntime<Config>): string => {
	const config = runtime.config

	// 1. The private half of the mandate, released by the Vault DON into this enclave only.
	const secrets = runtime
		.getSecrets(Object.values(MANDATE_SECRET_IDS).map((id) => ({ id })))
		.result()
	const mandate = mandateFromSecrets(config.poolId as Hex, secrets)
	const hash = mandateHash(mandate)

	// 2. Refuse thresholds the user did not sign: the recomputed hash must match the committed one.
	// 3. Otherwise read the tick from inside the enclave and decide.
	const verdict: Verdict =
		hash === config.mandateHash
			? decideRecentre({
					tick: readTick(runtime),
					tickSpacing: config.tickSpacing,
					position: config.position,
					mandate,
					now: Math.floor(runtime.now().getTime() / 1000),
				})
			: { act: false, reason: 'mandate hash mismatch' }

	// 4. Cross back with the verdict only. The thresholds, the tick, and the RPC response stay here.
	runtime
		.usingTheDons()
		.report({
			encodedPayload: hexToBase64(encodeVerdict(verdict, hash)),
			encoderName: 'evm',
			signingAlgo: 'ecdsa',
			hashingAlgo: 'keccak256',
		})
		.result()

	return verdict.act
		? `RECENTER ${verdict.tickLower}..${verdict.tickUpper}`
		: `HOLD (${verdict.reason})`
}

// ─── Workflow init ───────────────────────────────────────────
export function initWorkflow(config: Config) {
	const cronTrigger = new cre.capabilities.CronCapability()
	return [
		// AWS Nitro in us-west-2 is currently the only registered TEE type and region.
		cre.handlerInTee(cronTrigger.trigger({ schedule: config.schedule }), onCronTrigger, [
			{ tee: 'nitro', regions: ['us-west-2'] },
		]),
	]
}
