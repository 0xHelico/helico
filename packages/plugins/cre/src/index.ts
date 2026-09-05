import {
	bytesToHex,
	cre,
	EVMClient,
	getNetwork,
	hexToBase64,
	type Runtime,
	type TeeRuntime,
	TxStatus,
} from '@chainlink/cre-sdk'
import { type Address, encodeAbiParameters, type Hex, zeroAddress } from 'viem'
import { z } from 'zod'
import { recenterParamsAbi } from './abi'
import { type ChainState, poolIdOf, readChainState } from './chain'
import { decideRecentre, type Verdict } from './decision'
import { MANDATE_SECRET_IDS, type Mandate, mandateFromSecrets, mandateHash } from './mandate'
import { sizeRecentre } from './sizing'

export * from './abi'
export * from './chain'
export * from './decision'
export * from './mandate'
export * from './math'
export * from './sizing'

const hex = (bytes: number) => z.string().regex(new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`))

// ─── Public config ───────────────────────────────────────────
// Everything here is visible to node operators. The mandate's thresholds come from secrets;
// the position, its range, and the cooldown are read from the vault, which is the source of truth.
// No `.url()`: zod backs it with `new URL()`, which the WASM runtime does not provide.
export const configSchema = z.object({
	schedule: z.string(),
	/** JSON-RPC endpoint the enclave reads through; any chain with a v4 StateView. */
	rpcUrl: z.string().regex(/^https?:\/\/\S+$/),
	/** CRE chain selector name the report is written on, e.g. `robinhood-testnet`. */
	chainSelectorName: z.string().min(1),
	vault: hex(20),
	positionManager: hex(20),
	stateView: hex(20),
	/** The address that committed the mandate; the report acts on their position only. */
	owner: hex(20),
	poolId: hex(32),
	/** `keccak256(abi.encode(mandate))` as committed in the vault. */
	mandateHash: hex(32),
	gasLimit: z.string().regex(/^\d+$/),
	/** Enclave policy, not mandate: slippage on the burn and the mint. */
	slippageBps: z.number().int().min(0).max(5000),
	deadlineSeconds: z.number().int().positive(),
})
export type Config = z.infer<typeof configSchema>

export type RecenterParams = {
	owner: Address
	tickLower: number
	tickUpper: number
	liquidityToMint: bigint
	amount0Min: bigint
	amount1Min: bigint
	amount0Max: bigint
	amount1Max: bigint
	deadline: bigint
}

const REPORT_ABI = [{ type: 'bool' }, { type: 'bytes32' }, recenterParamsAbi] as const

const noParams: RecenterParams = {
	owner: zeroAddress,
	tickLower: 0,
	tickUpper: 0,
	liquidityToMint: 0n,
	amount0Min: 0n,
	amount1Min: 0n,
	amount0Max: 0n,
	amount1Max: 0n,
	deadline: 0n,
}

/** `abi.encode(bool act, bytes32 mandateHash, RecenterParams p)`: the vault decodes its own struct. */
export const encodeReport = (act: boolean, hash: Hex, p: RecenterParams = noParams): Hex =>
	encodeAbiParameters(REPORT_ABI, [act, hash, p])

export type Outcome = { act: false; reason: string } | { act: true; params: RecenterParams }

/** Policy and sizing on top of the chain state. Pure. */
export function decide(config: Config, mandate: Mandate, state: ChainState, now: number): Outcome {
	if (!state.active) return { act: false, reason: 'mandate revoked' }
	if (poolIdOf(state.poolKey) !== config.poolId)
		return { act: false, reason: 'position is not in the mandated pool' }

	const verdict: Verdict = decideRecentre({
		tick: state.tick,
		tickSpacing: state.poolKey.tickSpacing,
		position: {
			tickLower: state.tickLower,
			tickUpper: state.tickUpper,
			lastActionAt: state.lastActionAt,
		},
		mandate,
		now,
	})
	if (!verdict.act) return verdict
	if (state.liquidity === 0n) return { act: false, reason: 'vault would reject: NothingToMove' }
	if (state.liquidity > mandate.maxLiquidity)
		return { act: false, reason: 'vault would reject: LiquidityTooLarge' }

	const sizing = sizeRecentre({
		liquidity: state.liquidity,
		sqrtPriceX96: state.sqrtPriceX96,
		current: { tickLower: state.tickLower, tickUpper: state.tickUpper },
		proposed: verdict,
		slippageBps: config.slippageBps,
	})
	// The mandate's floor, applied before the vault has to: below it the burn would return most of
	// the value to the wallet and the vault would revert LiquidityNotRetained anyway.
	if (sizing.liquidityToMint * 10_000n < state.liquidity * BigInt(mandate.minRetainedBps)) {
		return { act: false, reason: 'the burn cannot fund the new range without a swap' }
	}
	return {
		act: true,
		params: {
			owner: config.owner as Address,
			tickLower: verdict.tickLower,
			tickUpper: verdict.tickUpper,
			liquidityToMint: sizing.liquidityToMint,
			amount0Min: sizing.amount0Min,
			amount1Min: sizing.amount1Min,
			amount0Max: sizing.amount0Max,
			amount1Max: sizing.amount1Max,
			deadline: BigInt(now + config.deadlineSeconds),
		},
	}
}

// ─── TEE cron callback ───────────────────────────────────────
export const onCronTrigger = (runtime: TeeRuntime<Config>): string => {
	const config = runtime.config

	// 1. The mandate's thresholds, released by the Vault DON into this enclave only.
	const secrets = runtime
		.getSecrets(Object.values(MANDATE_SECRET_IDS).map((id) => ({ id })))
		.result()
	const mandate = mandateFromSecrets(config.poolId as Hex, secrets)
	const hash = mandateHash(mandate)
	const now = Math.floor(runtime.now().getTime() / 1000)

	// 2. Refuse thresholds the user did not sign before touching the chain.
	if (hash !== config.mandateHash) return 'HOLD (mandate hash mismatch)'

	// 3. Read the account, the pool, and the position from inside the enclave.
	const state = readChainState(
		runtime,
		config.rpcUrl,
		{
			vault: config.vault as Address,
			positionManager: config.positionManager as Address,
			stateView: config.stateView as Address,
		},
		config.owner as Address,
		config.poolId as Hex,
	)

	// 4. Decide, then size the mint the burn will fund.
	const outcome = decide(config, mandate, state, now)
	if (!outcome.act) return `HOLD (${outcome.reason})`

	// 5. Cross back with the verdict only, and deliver it to the vault through the forwarder.
	const txHash = deliver(runtime.usingTheDons(), config, encodeReport(true, hash, outcome.params))
	const { tickLower, tickUpper } = outcome.params
	return `RECENTER ${tickLower}..${tickUpper} tx ${txHash}`
}

/** Signs `payload` as a DON report and writes it to the vault. Returns the transaction hash. */
export function deliver(don: Runtime<Config>, config: Config, payload: Hex): Hex {
	const report = don
		.report({
			encodedPayload: hexToBase64(payload),
			encoderName: 'evm',
			signingAlgo: 'ecdsa',
			hashingAlgo: 'keccak256',
		})
		.result()
	const network = getNetwork({ chainFamily: 'evm', chainSelectorName: config.chainSelectorName })
	if (!network) throw new Error(`Unknown chain selector name ${config.chainSelectorName}`)
	const written = new EVMClient(network.chainSelector.selector)
		.writeReport(don, { receiver: config.vault, report, gasConfig: { gasLimit: config.gasLimit } })
		.result()
	if (written.txStatus !== TxStatus.SUCCESS) {
		throw new Error(`writeReport failed: ${written.errorMessage || TxStatus[written.txStatus]}`)
	}
	return bytesToHex(written.txHash ?? new Uint8Array(32))
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
