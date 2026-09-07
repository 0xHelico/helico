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
import { bufferNote, readMandateDemand, withMandateBuffer } from './subgraph'
import { eligibleVenues } from './venues'

export * from './abi'
export * from './ai'
export * from './chain'
export * from './decision'
export * from './mandate'
export * from './policy'
export * from './relay'
export * from './sign'
export * from './sizing'
export * from './subgraph'
export * from './venues'

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
	/**
	 * The lending markets to choose between, in the owner's own order — which is what breaks a
	 * tie between two paying the same. The account must already permit each of them; the enclave
	 * reads the allowlist rather than assuming it, and a market it does not permit is skipped
	 * rather than fatal.
	 *
	 * A list of one is the single-market configuration this workflow started as, and behaves
	 * exactly as it did. Every entry has to be an Aave-family market that answers
	 * `getReserveAToken`, `getVirtualUnderlyingBalance` and `getReserveData` for this asset:
	 * one that cannot is not skipped, it fails the run, because a view missing a market's rate
	 * would pick the best of the rest and call it the best.
	 */
	pools: z.array(hex(20)).min(1),
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

	// ─── The index the chain cannot replace ──────────────────────
	// Aqua's `_balances` is private and four levels deep and none of its four events indexes a
	// parameter, so "what could this maker's mandates still spend?" has no on-chain answer. The
	// buffer that has to cover exactly that is sized from the subgraph, and only ever raised by
	// it — see `subgraph.ts`.
	//
	// Leave `subgraphUrl` empty to turn it off; the buffer is then the owner's `minIdleAmount`
	// alone, which is what every run did before this existed.
	subgraphUrl: z
		.string()
		.regex(/^https?:\/\/\S+$/)
		.or(z.literal(''))
		.default(''),
	subgraphTimeoutSeconds: z.number().int().positive().max(60).default(20),
}

export const configSchema = z
	.object(configShape)
	.refine((c) => c.delivery !== 'forwarder' || c.chainSelectorName !== undefined, {
		message: 'forwarder delivery needs chainSelectorName',
	})
	.refine((c) => c.delivery !== 'signature' || c.chainId !== undefined, {
		message: 'signature delivery needs chainId',
	})
	// A market named twice is read twice and then compared against itself, which is a rate gap of
	// zero dressed up as a choice. Refused here rather than deduplicated, because the two readings
	// of a repeated address — a typo, or a market meant to count double — are not the same wish.
	.refine((c) => new Set(c.pools).size === c.pools.length, {
		message: 'pools must not repeat a market',
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
 * The agent check is the only fatal one: an account that no longer names this enclave has nothing
 * for it to decide. Everything else the account would enforce is per market and disqualifies that
 * market alone — `eligibleVenues` takes them out of the list, and the run goes on with what is
 * left, which is the rule `_venueFor` follows in the contract.
 */
export function decide(
	config: Config,
	policy: IdlePolicy,
	state: AccountState,
	now: number,
): Outcome {
	if (state.agent.toLowerCase() !== config.agent)
		return { act: false, reason: 'the account has not nominated this agent' }

	const { usable, skipped } = eligibleVenues(config.asset, state.venues)
	// With nothing usable there is no decision to hold on, only a list of markets and the reason
	// each was refused. A configuration naming one market keeps that market's own sentence, which
	// is what an owner running a single-venue account needs to read; several markets get every
	// address with its reason, because "the venue does not list this asset" answers nothing when
	// there were three of them.
	const [only] = skipped
	if (usable.length === 0 && only) {
		const each = skipped.map(({ pool, reason }) => `${pool} — ${reason}`).join('; ')
		return {
			act: false,
			reason: skipped.length === 1 ? only.reason : `no venue is usable (${each})`,
		}
	}

	const verdict = decideIdleMove({ policy, balances: { idle: state.idle, venues: usable }, now })
	if (!verdict.act) return verdict

	const sizing = sizeIdleMove({
		supply: verdict.supply,
		amount: verdict.amount,
		venueLiquidity: verdict.venue.venueLiquidity,
		maxMoveAmount: policy.maxMoveAmount,
	})
	// Kept as a guard on the signing boundary rather than as a live path: the market was chosen
	// for being able to hand back at least the bar this move has to clear, so a zero should not
	// reach here. Nothing signs a move for nothing if that ever stops being true.
	if (sizing.amount === 0n)
		return { act: false, reason: 'the venue cannot return anything right now' }
	// The deadband again, on the number that will actually be sent — and for a migration that is
	// the round-trip bar, not the ordinary one. A withdrawal cut down to a few units because the
	// market is drained is exactly the move the deadband exists to refuse, and it only becomes
	// small here, after the target split, which knew nothing about it.
	if (sizing.amount < verdict.deadband)
		return { act: false, reason: `${sizing.limitedBy} leaves a move inside the deadband` }

	return {
		act: true,
		params: {
			account: config.account as Address,
			pool: verdict.venue.pool,
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

	// 3. Read the account and every market it may use, from inside the enclave.
	const state = readAccountState(
		runtime,
		config.rpcUrl,
		{
			account: config.account as Address,
			pools: config.pools as Address[],
			asset: config.asset as Address,
		},
		{ withNonce: signs, nonceFunction: config.nonceFunction },
	)

	// 3b. Ask The Graph what this account's live Aqua mandates could still spend of the asset, and
	//     raise the liquid buffer to it. The account is the maker in Aqua's ledger, a swap against
	//     one of its mandates is served out of the wallet first, and that question has no
	//     on-chain answer — so the index is the only place the number exists. An index that is
	//     down, empty or behind never turns the decision into a wrong one: it can only fail to
	//     raise a floor, and the run falls back to the owner's own `minIdleAmount`. See
	//     `subgraph.ts` for what each of those does to the next swap.
	const demand = readMandateDemand(runtime, config, config.account, config.asset)
	// Never hashed: `hash` above commits to the secrets the owner published, and this is not
	// those secrets.
	const effective = withMandateBuffer(policy, demand)
	const buffer = config.subgraphUrl ? ` [${bufferNote(policy, demand)}]` : ''

	// 4. Decide which market the capital should sit in, and how much of the difference is worth
	//    moving. One move leaves per run, because the account's nonce is strictly sequential.
	const outcome = decide(config, effective, state, now)

	// 4b. Ask the model to say why, in the owner's words. Never load-bearing: a missing or
	//     rejected answer changes nothing about what happens next. It is handed every market the
	//     decision was allowed to consider, so a hold about a rate gap has the rates in front of
	//     it.
	const { usable } = eligibleVenues(config.asset, state.venues)
	const reason = config.aiUrl
		? explain(
				runtime,
				config,
				secrets,
				describeForOwner(
					config.asset,
					effective,
					{ idle: state.idle, venues: usable },
					targetSplit(effective, { idle: state.idle, venues: usable }),
					outcome,
					// The model is handed the buffer it is explaining *and* where that buffer came
					// from. Without it, a floor raised by a mandate reads as the owner's own number
					// and the sentence about the policy is wrong.
					config.subgraphUrl ? { policy, demand } : undefined,
				),
			)
		: undefined
	const because = reason ? ` — ${reason}` : ''

	if (!outcome.act) return `HOLD (${outcome.reason})${buffer}${because}`
	// The market is named in the line, not only in the report: with several to choose between,
	// "SUPPLY 800000000" no longer says what happened.
	const move = outcome.params.supply
		? `SUPPLY ${outcome.params.amount} to ${outcome.params.pool}`
		: `WITHDRAW ${outcome.params.amount} from ${outcome.params.pool}`

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
		// The buffer note goes before the statement, never after: `rehearse-idle.sh` reads the
		// JSON out of this line with a greedy match to the last `}`, and prose behind it would be
		// swallowed into what it tries to parse.
		return `${move}${buffer} ${authorisationJson(auth, signature, signer)}${because}`
	}
	const txHash = deliver(runtime.usingTheDons(), config, encodeReport(true, hash, outcome.params))
	return `${move}${buffer} tx ${txHash}${because}`
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
