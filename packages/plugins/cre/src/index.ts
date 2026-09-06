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
import { type RecenterParams, recenterParamsAbi } from './abi'
import { AI_SECRET_IDS, describeForOwner, explain } from './ai'
import { type ChainState, poolIdOf, readChainState } from './chain'
import { decideRecentre, type Verdict } from './decision'
import { MANDATE_SECRET_IDS, type Mandate, mandateFromSecrets, mandateHash } from './mandate'
import { type Authorisation, encodeAuthorisation, type RecentreDomain, signRecentre } from './sign'
import { sizeRecentre } from './sizing'

export * from './abi'
export * from './ai'
export * from './chain'
export * from './decision'
export * from './mandate'
export * from './math'
export * from './relay'
export * from './sign'
export * from './sizing'

// Lowercased so a checksummed value in config compares equal to keccak output and to what we encode.
const hex = (bytes: number) =>
	z
		.string()
		.regex(new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`))
		.transform((v) => v.toLowerCase())

// ─── Public config ───────────────────────────────────────────
// Everything here is visible to node operators. The mandate's thresholds come from secrets;
// the position, its range, and the cooldown are read from the vault, which is the source of truth.
// No `.url()`: zod backs it with `new URL()`, which the WASM runtime does not provide.
export const configShape = {
	schedule: z.string(),
	/** JSON-RPC endpoint the enclave reads through; any chain with a v4 StateView. */
	rpcUrl: z.string().regex(/^https?:\/\/\S+$/),
	/**
	 * How the verdict reaches the vault. `forwarder`: `EVMClient.writeReport` on `chainSelectorName`,
	 * for chains with a CRE forwarder. `signature`: the enclave signs an EIP-712 authorisation with
	 * the agent key from the Vault DON and hands it out for anyone to relay; works on any chain.
	 */
	delivery: z.enum(['forwarder', 'signature']),
	/** CRE chain selector name the report is written on, e.g. `robinhood-testnet`; forwarder delivery only. */
	chainSelectorName: z.string().min(1).optional(),
	/** The chain id in the EIP-712 domain; signature delivery only. */
	chainId: z.number().int().positive().optional(),
	/** EIP-712 domain name and version the vault uses; signature delivery only. */
	domainName: z.string().default('HelicoVault'),
	domainVersion: z.string().default('1'),
	/** Vault DON secret id holding the agent's private key; signature delivery only. */
	agentKeySecretId: z.string().default('AGENT_KEY'),
	/** The vault's nonce getter; signature delivery only. */
	noncesFunction: z.string().default('nonces'),
	vault: hex(20),
	positionManager: hex(20),
	stateView: hex(20),
	/** The address that committed the mandate; the report acts on their position only. */
	owner: hex(20),
	poolId: hex(32),
	/** `keccak256(abi.encode(mandate))` as committed in the vault. */
	mandateHash: hex(32),
	gasLimit: z.string().regex(/^\d+$/),
	/** Enclave policy, not mandate: slippage on the burn, the swap, and the mint. */
	slippageBps: z.number().int().min(0).max(5000),
	/** Enclave policy: refuse to route a re-centre through a pool whose LP fee is above this, in pips. */
	maxPoolFeePips: z.number().int().min(0).max(1_000_000),
	deadlineSeconds: z.number().int().positive(),

	// ─── The enclave's explanation ───────────────────────────────
	// A model turns the verdict into a sentence the position's owner can read. It decides
	// nothing: `decide` has already chosen and the vault re-checks every rule on chain, so a
	// confused model produces a confusing sentence and cannot move a position.
	//
	// It can only run here. A non-confidential workflow calls an endpoint from every node and
	// takes a consensus; ten nodes asking a model the same question get ten different answers,
	// and free text has no median. Inside the enclave the call happens once.
	//
	// Leave `aiUrl` empty to turn it off — every path then behaves as it did before.
	aiUrl: z
		.string()
		.regex(/^https?:\/\/\S+$/)
		.or(z.literal(''))
		.default(''),
	aiModel: z.string().default('ag/claude-opus-4-6-thinking'),
	/** Tried when the first errors, times out, or returns something the guards reject. */
	aiFallbackModel: z.string().default('ag/gemini-3-flash'),
	aiMaxTokens: z.number().int().positive().default(1200),
	aiTimeoutSeconds: z.number().int().positive().max(60).default(30),
}

export const configSchema = z
	.object(configShape)
	.refine((c) => c.delivery !== 'forwarder' || c.chainSelectorName !== undefined, {
		message: 'forwarder delivery needs chainSelectorName',
	})
	.refine((c) => c.delivery !== 'signature' || c.chainId !== undefined, {
		message: 'signature delivery needs chainId',
	})
export type Config = z.infer<typeof configSchema>

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
	zeroForOne: false,
	amountIn: 0n,
	minAmountOut: 0n,
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
	// A re-centre swaps through the position's own pool; on a launch pool at 20% that costs more
	// than it recovers, and no mandate field can express that judgement.
	if (state.lpFee > config.maxPoolFeePips)
		return { act: false, reason: 'pool fee above the enclave ceiling' }

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
		poolLiquidity: state.poolLiquidity,
		feePips: state.lpFee,
		slippageBps: config.slippageBps,
	})
	// Never a zero mint, whatever the floor says: a mandate with minRetainedBps = 0 would let
	// 0 < 0 pass and turn a re-centre into a withdrawal.
	if (sizing.liquidityToMint === 0n)
		return { act: false, reason: 'vault would reject: NothingToMint' }
	// The mandate's floor, applied before the vault has to revert LiquidityNotRetained.
	if (sizing.liquidityToMint * 10_000n < state.liquidity * BigInt(mandate.minRetainedBps)) {
		return { act: false, reason: "below the mandate's retention floor" }
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
			zeroForOne: sizing.zeroForOne,
			amountIn: sizing.amountIn,
			minAmountOut: sizing.minAmountOut,
			deadline: BigInt(now + config.deadlineSeconds),
		},
	}
}

// ─── TEE cron callback ───────────────────────────────────────
export const onCronTrigger = async (runtime: TeeRuntime<Config>): Promise<string> => {
	const config = runtime.config
	const signs = config.delivery === 'signature'

	// 1. The mandate's thresholds, and in signature mode the agent key, released by the Vault DON
	//    into this enclave only. The key is used here and never crosses out.
	const ids = [
		...Object.values(MANDATE_SECRET_IDS),
		...(signs ? [config.agentKeySecretId] : []),
		...(config.aiUrl ? Object.values(AI_SECRET_IDS) : []),
	]
	const secrets = runtime.getSecrets(ids.map((id) => ({ id }))).result()
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
		{ withNonce: signs, noncesFunction: config.noncesFunction },
	)

	// 4. Decide, then size the swap and the mint the burn will fund.
	const outcome = decide(config, mandate, state, now)

	// 4b. Ask the model to say why, in the owner's words. Never load-bearing: a missing or
	//     rejected answer changes nothing about what happens next.
	const reason = config.aiUrl
		? explain(runtime, config, secrets, describeForOwner(config, mandate, state, outcome, now))
		: undefined
	const because = reason ? ` — ${reason}` : ''

	if (!outcome.act) return `HOLD (${outcome.reason})${because}`
	const { tickLower, tickUpper } = outcome.params

	// 5. Cross back with the verdict only.
	if (signs) {
		const key = secrets[config.agentKeySecretId]?.value as Hex | undefined
		if (!key) throw new Error(`Secret ${config.agentKeySecretId} is missing`)
		if (state.nonce === undefined) throw new Error('The vault did not answer the nonce read')
		const auth: Authorisation = { params: outcome.params, mandateHash: hash, nonce: state.nonce }
		const domain: RecentreDomain = {
			name: config.domainName,
			version: config.domainVersion,
			chainId: config.chainId as number,
			verifyingContract: config.vault as Address,
		}
		const { signature, signer } = await signRecentre(key, domain, auth)
		// The authorisation is public by design once relayed; it is what the DON attests to.
		runtime
			.usingTheDons()
			.report({
				encodedPayload: hexToBase64(encodeAuthorisation(auth, signature)),
				encoderName: 'evm',
				signingAlgo: 'ecdsa',
				hashingAlgo: 'keccak256',
			})
			.result()
		return `RECENTER ${tickLower}..${tickUpper} ${authorisationJson(auth, signature, signer)}${because}`
	}
	const txHash = deliver(runtime.usingTheDons(), config, encodeReport(true, hash, outcome.params))
	return `RECENTER ${tickLower}..${tickUpper} tx ${txHash}${because}`
}

/** The signed authorisation as the simulator prints it, for a relayer to pick up. */
export const authorisationJson = (auth: Authorisation, signature: Hex, signer: Address): string =>
	JSON.stringify(
		{ params: auth.params, mandateHash: auth.mandateHash, nonce: auth.nonce, signature, signer },
		(_, v) => (typeof v === 'bigint' ? v.toString() : v),
	)

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
	const network = getNetwork({
		chainFamily: 'evm',
		chainSelectorName: config.chainSelectorName ?? '',
	})
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
