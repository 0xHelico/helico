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
import { type IdleMoveParams, idleMoveParamsAbi } from './abi'
import { AI_SECRET_IDS, describeForOwner, explain } from './ai'
import { type AccountState, readAccountState } from './chain'
import { decideIdleMove, targetSplit } from './decision'
import { type IdlePolicy, POLICY_SECRET_IDS, policyFromSecrets, policyHash } from './policy'
import { encodeIdleMove } from './relay'
import { type Authorisation, encodeAuthorisation, type IdleMoveDomain, signIdleMove } from './sign'
import { sizeIdleMove } from './sizing'

export * from './abi'
export * from './ai'
export * from './chain'
export * from './decision'
export * from './mandate'
export * from './policy'
export * from './relay'
export * from './sign'
export * from './sizing'

// Lowercased so a checksummed value in config compares equal to keccak output, to what an
// `eth_call` decodes to, and to what we encode.
const hex = (bytes: number) =>
	z
		.string()
		.regex(new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`))
		.transform((v) => v.toLowerCase())

// ─── Public config ───────────────────────────────────────────
// Everything here is visible to node operators. The account, the market and the asset have to
// be: they are on chain and anyone can read them. What is not here is the policy — how much
// should be working, how much must stay liquid, how large a difference is worth moving — which
// comes from secrets released only into the enclave.
// No `.url()`: zod backs it with `new URL()`, which the WASM runtime does not provide.
export const configShape = {
	schedule: z.string(),
	/** JSON-RPC endpoint the enclave reads through. */
	rpcUrl: z.string().regex(/^https?:\/\/\S+$/),
	/**
	 * How the verdict leaves the enclave. `forwarder`: `EVMClient.writeReport` on
	 * `chainSelectorName`, for chains with a CRE forwarder. `signature`: the enclave signs an
	 * EIP-712 statement with the agent key from the Vault DON and hands it out, with the calldata,
	 * for anyone to carry; works on any chain.
	 */
	delivery: z.enum(['forwarder', 'signature']),
	/** CRE chain selector name the report is written on; forwarder delivery only. */
	chainSelectorName: z.string().min(1).optional(),
	/** The chain id in the EIP-712 domain; signature delivery only. */
	chainId: z.number().int().positive().optional(),
	/** The account's EIP-712 domain, as `AccountAuth` builds it; signature delivery only. */
	domainName: z.string().default('HelicoAccount'),
	domainVersion: z.string().default('1'),
	/** Vault DON secret id holding the agent's private key; signature delivery only. */
	agentKeySecretId: z.string().default('AGENT_KEY'),
	/** The account's nonce getter. Takes no argument, unlike the vault's `nonces(address)`. */
	nonceFunction: z.string().default('nonce'),
	/** The `HelicoAccount` whose idle capital this workflow manages. */
	account: hex(20),
	/** The lending market. The account must already permit it; the enclave checks rather than assumes. */
	pool: hex(20),
	/** The ERC-20 being placed. */
	asset: hex(20),
	/**
	 * The address the owner nominated as the agent. The enclave holds the key behind it and stops
	 * when the account no longer names it, so a revocation shows up as a hold on the next run
	 * instead of as a transaction that reverts.
	 */
	agent: hex(20),
	/**
	 * Where a DON report is written; forwarder delivery only, and zero until one is deployed.
	 *
	 * It is not the account. `HelicoAccount` does not implement `IReceiver` — it has no
	 * `onReport` — so a report cannot be written to it, and pointing this at the account would
	 * produce a write that reverts rather than a move.
	 */
	reportReceiver: hex(20),
	/**
	 * `keccak256(abi.encode(policy))` as the owner published it, or zero for "not committed".
	 * Nothing on chain holds this; see `policy.ts` for what the check does and does not prove.
	 */
	policyHash: hex(32),
	gasLimit: z.string().regex(/^\d+$/),
	/** How long the enclave's statement about a move stays current. */
	deadlineSeconds: z.number().int().positive(),

	// ─── The enclave's explanation ───────────────────────────────
	// A model turns the verdict into a sentence the account's owner can read. It decides
	// nothing: `decide` has already chosen and the account enforces the shape of the call
	// whatever the model says, so a confused model produces a confusing sentence and cannot
	// move anyone's capital.
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

const REPORT_ABI = [{ type: 'bool' }, { type: 'bytes32' }, idleMoveParamsAbi] as const

const ZERO_HASH = `0x${'0'.repeat(64)}` as const

const noParams: IdleMoveParams = {
	account: zeroAddress,
	pool: zeroAddress,
	asset: zeroAddress,
	amount: 0n,
	supply: false,
	deadline: 0n,
}

/** `abi.encode(bool act, bytes32 policyHash, IdleMoveParams p)`. */
export const encodeReport = (act: boolean, hash: Hex, p: IdleMoveParams = noParams): Hex =>
	encodeAbiParameters(REPORT_ABI, [act, hash, p])

export type Outcome = { act: false; reason: string } | { act: true; params: IdleMoveParams }

/**
 * Policy and sizing on top of the chain state. Pure.
 *
 * The four refusals at the top are the ones the account itself would enforce, checked here so a
 * run that cannot succeed ends as a hold with a reason rather than as a reverted transaction
 * with a selector. The receipt check is the exception: the account does not make it, and it is
 * the one that stops an amount denominated in one asset being spent out of a balance
 * denominated in another.
 */
export function decide(
	config: Config,
	policy: IdlePolicy,
	state: AccountState,
	now: number,
): Outcome {
	if (state.agent.toLowerCase() !== config.agent)
		return { act: false, reason: 'the account has not nominated this agent' }
	// A revocation is an instruction, not a pause. If the owner has revoked this venue and the
	// account still has a position in it, the useful thing to do is bring it home — holding beside
	// it would leave the money exactly where the owner said they did not want it. The account
	// permits precisely this: `withdrawIdle` is gated on `venueEverPermitted`, so the agent can
	// still unwind a venue it can no longer supply.
	//
	// Nothing is read from the venue for this. The whole position comes out, sizing and deadband
	// included, because a deadband exists to suppress moves that are not worth their gas and this
	// one was asked for.
	if (!state.venuePermitted) {
		if (state.supplied === 0n)
			return { act: false, reason: 'the owner has not permitted this venue' }
		return {
			act: true,
			params: {
				account: config.account as Address,
				pool: config.pool as Address,
				asset: config.asset as Address,
				amount: state.supplied,
				supply: false,
				deadline: BigInt(now + config.deadlineSeconds),
			},
		}
	}
	if (state.receipt === zeroAddress)
		return { act: false, reason: 'the venue does not list this asset' }
	if (state.receiptAsset.toLowerCase() !== config.asset)
		return { act: false, reason: "the venue's receipt is for a different asset" }

	const balances = {
		idle: state.idle,
		supplied: state.supplied,
		supplyRateRay: state.supplyRateRay,
	}
	const verdict = decideIdleMove({ policy, balances, now })
	if (!verdict.act) return verdict

	const sizing = sizeIdleMove({
		supply: verdict.supply,
		amount: verdict.amount,
		venueLiquidity: state.venueLiquidity,
		maxMoveAmount: policy.maxMoveAmount,
	})
	if (sizing.amount === 0n)
		return { act: false, reason: 'the venue cannot return anything right now' }
	// The deadband again, on the number that will actually be sent. A withdrawal cut down to a
	// few units because the market is drained is exactly the move the deadband exists to refuse,
	// and it only becomes small here — after the target split, which knew nothing about it.
	if (sizing.amount < verdict.deadband)
		return { act: false, reason: `${sizing.limitedBy} leaves a move inside the deadband` }

	return {
		act: true,
		params: {
			account: config.account as Address,
			pool: config.pool as Address,
			asset: config.asset as Address,
			amount: sizing.amount,
			supply: verdict.supply,
			deadline: BigInt(now + config.deadlineSeconds),
		},
	}
}

// ─── TEE cron callback ───────────────────────────────────────
export const onCronTrigger = async (runtime: TeeRuntime<Config>): Promise<string> => {
	const config = runtime.config
	const signs = config.delivery === 'signature'

	// 1. The policy, and in signature mode the agent key, released by the Vault DON into this
	//    enclave only. The key is used here and never crosses out.
	const ids = [
		...Object.values(POLICY_SECRET_IDS),
		...(signs ? [config.agentKeySecretId] : []),
		...(config.aiUrl ? Object.values(AI_SECRET_IDS) : []),
	]
	const secrets = runtime.getSecrets(ids.map((id) => ({ id }))).result()
	const policy = policyFromSecrets(secrets)
	const hash = policyHash(policy)
	const now = Math.floor(runtime.now().getTime() / 1000)

	// 2. Refuse thresholds the owner did not publish, before touching the chain. A zero hash in
	//    config means they published none, and then there is nothing to disagree with.
	if (config.policyHash !== ZERO_HASH && hash !== config.policyHash)
		return 'HOLD (policy hash mismatch)'

	// 3. Read the account and the market from inside the enclave.
	const state = readAccountState(
		runtime,
		config.rpcUrl,
		{
			account: config.account as Address,
			pool: config.pool as Address,
			asset: config.asset as Address,
		},
		{ withNonce: signs, nonceFunction: config.nonceFunction },
	)

	// 4. Decide where the capital should sit, and how much of the difference is worth moving.
	const outcome = decide(config, policy, state, now)

	// 4b. Ask the model to say why, in the owner's words. Never load-bearing: a missing or
	//     rejected answer changes nothing about what happens next.
	const reason = config.aiUrl
		? explain(
				runtime,
				config,
				secrets,
				describeForOwner(
					{ pool: config.pool, asset: config.asset },
					policy,
					state,
					targetSplit(policy, {
						idle: state.idle,
						supplied: state.supplied,
						supplyRateRay: state.supplyRateRay,
					}),
					outcome,
				),
			)
		: undefined
	const because = reason ? ` — ${reason}` : ''

	if (!outcome.act) return `HOLD (${outcome.reason})${because}`
	const verb = outcome.params.supply ? 'SUPPLY' : 'WITHDRAW'

	// 5. Cross back with the move only.
	if (signs) {
		const key = secrets[config.agentKeySecretId]?.value as Hex | undefined
		if (!key) throw new Error(`Secret ${config.agentKeySecretId} is missing`)
		if (state.nonce === undefined) throw new Error('The account did not answer the nonce read')
		const auth: Authorisation = { params: outcome.params, policyHash: hash, nonce: state.nonce }
		const domain: IdleMoveDomain = {
			name: config.domainName,
			version: config.domainVersion,
			chainId: config.chainId as number,
			verifyingContract: config.account as Address,
		}
		const { signature, signer } = await signIdleMove(key, domain, auth)
		// The statement is public by design once relayed; it is what the DON attests to.
		runtime
			.usingTheDons()
			.report({
				encodedPayload: hexToBase64(encodeAuthorisation(auth, signature)),
				encoderName: 'evm',
				signingAlgo: 'ecdsa',
				hashingAlgo: 'keccak256',
			})
			.result()
		return `${verb} ${outcome.params.amount} ${authorisationJson(auth, signature, signer)}${because}`
	}
	const txHash = deliver(runtime.usingTheDons(), config, encodeReport(true, hash, outcome.params))
	return `${verb} ${outcome.params.amount} tx ${txHash}${because}`
}

/**
 * The signed statement as the simulator prints it, with the call it is about, so a relayer has
 * nothing left to work out.
 */
export const authorisationJson = (auth: Authorisation, signature: Hex, signer: Address): string =>
	JSON.stringify(
		{
			params: auth.params,
			policyHash: auth.policyHash,
			nonce: auth.nonce,
			signature,
			signer,
			call: encodeIdleMove(auth.params),
		},
		(_, v) => (typeof v === 'bigint' ? v.toString() : v),
	)

/** Signs `payload` as a DON report and writes it to the receiver. Returns the transaction hash. */
export function deliver(don: Runtime<Config>, config: Config, payload: Hex): Hex {
	// Refused rather than written into the void: `writeReport` to an address with no code
	// succeeds as a transaction and moves nothing, which reads in a log exactly like a move.
	if (config.reportReceiver === zeroAddress) {
		throw new Error('No report receiver is deployed; use signature delivery')
	}
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
		.writeReport(don, {
			receiver: config.reportReceiver,
			report,
			gasConfig: { gasLimit: config.gasLimit },
		})
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
