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
import { type AccountState, type AssetState, type Pool, readAccountState } from './chain'
import { decideIdleMove, type IdleBalances, targetSplit } from './decision'
import { type IdlePolicy, POLICY_SECRET_IDS, policyFromSecrets, policyHash } from './policy'
import { encodeIdleMove } from './relay'
import { type Authorisation, encodeAuthorisation, type IdleMoveDomain, signIdleMove } from './sign'
import { sizeIdleMove } from './sizing'
import {
	accountsNote,
	accountsToManage,
	bufferNote,
	readManagedAccounts,
	readMandateDemand,
	withMandateBuffer,
} from './subgraph'
import { eligibleVenues } from './venues'

export * from './abi'
export * from './ai'
export * from './chain'
export * from './decision'
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
	/**
	 * One `HelicoAccount` to manage regardless of what the index says, or the zero address.
	 *
	 * **Optional, and the zero address is the ordinary setting.** The accounts this run manages
	 * come from the subgraph, which sees every account the factory has ever opened — so naming one
	 * here is not how an account gets managed, it is how an account gets managed *even when the
	 * index cannot answer*.
	 *
	 * Worth setting for exactly one account: the one a demo depends on, where a subgraph outage
	 * turning into "the agent did nothing" is worse than the staleness of an address written by
	 * hand. Everywhere else, leave it zero and let the index do its job — an account opened a
	 * minute ago is then managed without anybody editing a file.
	 */
	account: hex(20).default(zeroAddress),
	/**
	 * The most accounts one run will read, decide about and rank.
	 *
	 * `evaluate` costs several `eth_call`s and one confidential HTTP request per account, and
	 * `open` is permissionless — so without a bound, anyone can grow what a cron tick has to do
	 * before it signs anything. That is not a way to take funds, it is a way to crowd an account
	 * out of its own run, which is why the anchor above is added before this limit is applied.
	 *
	 * Twenty-five because it is comfortably more than this will hold during judging and
	 * comfortably less than a run can time out on. Raise it when a run demonstrably finishes with
	 * room, not before.
	 */
	maxAccountsPerRun: z.number().int().positive().max(1000).default(25),
	/**
	 * The Vault DON namespace the secrets live in.
	 *
	 * `main` is the CLI's default, what `cre secrets list` reports against every identifier we
	 * hold, and what an omitted namespace resolves to — so naming it changes nothing today. It is
	 * here to be nameable, not because it was the bug.
	 *
	 * **It was written as the bug, and that was wrong.** `SecretRequest` carries a namespace and
	 * ours was empty, which looked like the cause of `relay quorum unreachable` — a message that
	 * reads like the DON is down. Chainlink's own skill reference settles it: the field is
	 * optional and defaults to `main`. The actual cause was the workflow declaring access to
	 * eight of the eleven secrets it asks for; see `apps/cre/secrets.yaml`.
	 *
	 * Kept rather than reverted because a namespace nobody names is how a workflow ends up
	 * reading someone else's, the day a second namespace exists.
	 */
	secretsNamespace: z.string().default('main'),
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
	pools: z
		.array(
			z.object({
				address: hex(20),
				/**
				 * How this market's receipt expresses its value, mirroring `ReceiptKind` in
				 * `contracts/src/ReceiptMath.sol`. `rebasing` is an Aave aToken, whose balance is already
				 * the position; `share-priced` is a Compound or Morpho venue, whose balance is a share
				 * count that has to be converted before anything treats it as an amount of asset.
				 *
				 * Defaulted rather than required, because every configuration written before share-priced
				 * venues existed named Aave markets and naming them again would be a migration for no
				 * reason. Getting it wrong in the other direction — calling a share-priced venue rebasing —
				 * under-reports the position rather than over-reporting it, so the default is the safe way
				 * round as well as the compatible one.
				 */
				kind: z.enum(['rebasing', 'share-priced']).default('rebasing'),
				/**
				 * The assets this market lists, when it does not list all of them. Omitted means every
				 * asset in `assets`, which is what an Aave Pool is — one address serving every reserve.
				 *
				 * **Required for a single-asset venue as soon as a second asset exists.** A
				 * `CompoundVenue` holds exactly one market and `getReserveAToken` on the wrong asset
				 * reverts; a failed call fails the whole run by design, so an unscoped USDC venue in a
				 * configuration that also names WETH does not earn less, it stops every run.
				 *
				 * Optional rather than required so that every configuration written before ETH could
				 * earn keeps its meaning: they named one asset, and a market that lists all of one
				 * asset is the same market either way.
				 */
				assets: z.array(hex(20)).min(1).optional(),
			}),
		)
		.min(1),
	/**
	 * The ERC-20s being placed, in the order the owner wrote them.
	 *
	 * **A list rather than one, and one workflow rather than one per asset.** Two workflows would
	 * have been a config change and no code, and they cannot see each other: `HelicoAccount.nonce`
	 * is strictly sequential, so on a run where both decide to move, the second signature is spent
	 * against a nonce the first already used and the move reverts. A rule about the account's total
	 * idle capital cannot exist across two agents either.
	 *
	 * `asset` is still accepted and folded in, so every configuration written before this keeps its
	 * meaning rather than needing a migration on the day it is read.
	 */
	assets: z.array(hex(20)).min(1),
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

/**
 * Fold a singular `asset` into `assets`, so a configuration written before the list existed keeps
 * its meaning.
 *
 * Before the object is parsed rather than after, because `assets` is required and a config with
 * only `asset` would otherwise fail validation before anything had a chance to translate it — and
 * the failure would name a field the author never wrote.
 *
 * If both are present the list wins and the singular is ignored rather than merged. Merging would
 * silently place an asset the author had already replaced.
 */
const foldSingularAsset = (raw: unknown): unknown => {
	if (typeof raw !== 'object' || raw === null) return raw
	const c = raw as Record<string, unknown>
	if (Array.isArray(c.assets) || typeof c.asset !== 'string') return raw
	const { asset: _dropped, ...rest } = c
	return { ...rest, assets: [c.asset] }
}

export const configSchema = z
	.preprocess(foldSingularAsset, z.object(configShape))
	.refine((c) => c.delivery !== 'forwarder' || c.chainSelectorName !== undefined, {
		message: 'forwarder delivery needs chainSelectorName',
	})
	.refine((c) => c.delivery !== 'signature' || c.chainId !== undefined, {
		message: 'signature delivery needs chainId',
	})
	// A market named twice is read twice and then compared against itself, which is a rate gap of
	// zero dressed up as a choice. Refused here rather than deduplicated, because the two readings
	// of a repeated address — a typo, or a market meant to count double — are not the same wish.
	// By address, not by entry. `pools` became objects when venue kinds arrived, and `new Set` over
	// objects compares references — so this guard would have kept its shape, kept its message, and
	// stopped refusing anything at all.
	.refine((c) => new Set(c.pools.map((p) => p.address)).size === c.pools.length, {
		message: 'pools must not repeat a market',
	})
	// An asset no market will take is capital the enclave watches sit idle and can never place —
	// which reads, on every run, as a decision to hold. Caught here because the alternative is a
	// workflow that runs green forever while one side of the account never earns anything.
	.refine(
		(c) =>
			c.assets.every((asset) =>
				c.pools.some(
					(pool) =>
						pool.assets === undefined ||
						pool.assets.some((a) => a.toLowerCase() === asset.toLowerCase()),
				),
			),
		{ message: 'every asset needs at least one market that lists it' },
	)
	// A market scoped to assets the account does not hold is a line nobody reads again. Usually a
	// typo in an address, and always a market that will never be compared to anything.
	.refine(
		(c) =>
			c.pools.every(
				(pool) =>
					pool.assets === undefined ||
					pool.assets.some((a) =>
						c.assets.some((asset) => asset.toLowerCase() === a.toLowerCase()),
					),
			),
		{ message: 'a market must list at least one asset the account holds' },
	)
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
export function decideForAsset(
	config: Config,
	policy: IdlePolicy,
	agent: string,
	side: AssetState,
	now: number,
): Outcome {
	if (agent.toLowerCase() !== config.agent)
		return { act: false, reason: 'the account has not nominated this agent' }

	const { usable, skipped, evacuate } = eligibleVenues(side.asset, side.venues)

	// An evacuation outranks everything below it. The owner revoked a market this account is
	// sitting in, and that is an instruction rather than one more input to the split — holding
	// beside the money would leave it exactly where the owner said they did not want it.
	//
	// Sizing and the deadband are skipped on purpose. Both exist to suppress moves that are not
	// worth their gas; this move was asked for, and a position too small to clear the deadband is
	// the one most worth finishing rather than leaving behind.
	const [leaving] = evacuate
	if (leaving)
		return {
			act: true,
			params: {
				account: config.account as Address,
				pool: leaving.pool,
				asset: side.asset,
				amount: leaving.amount,
				supply: false,
				deadline: BigInt(now + config.deadlineSeconds),
			},
		}

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

	const verdict = decideIdleMove({ policy, balances: { idle: side.idle, venues: usable }, now })
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
			asset: side.asset,
			amount: sizing.amount,
			supply: verdict.supply,
			deadline: BigInt(now + config.deadlineSeconds),
		},
	}
}

/** One account, read and judged. The fields the acting branch needs, and nothing else. */
type Judged = {
	account: string
	state: AccountState
	effective: IdlePolicy
	demand: ReturnType<typeof readMandateDemand>
	outcome: Outcome
	/** The buffer note for this account, already bracketed, or empty when no index is configured. */
	buffer: string
	/** Which asset the decision chose, so the explanation is about the move that is happening. */
	asset?: Address
}

/**
 * One move leaves per run, so with several assets the enclave must answer whose.
 *
 * **This is the reason the workflow is one workflow.** `HelicoAccount.nonce` is strictly
 * sequential — one signed statement authorises exactly one call — so two agents, one per asset,
 * would spend the same nonce on a run where both wanted to move and the second would revert. Only
 * a view that holds every asset can choose between them.
 *
 * **Ranked by rate gap, not by amount, and the difference is not cosmetic.** Amounts live in each
 * asset's own units: five WETH is `5e18` and five USDC is `5e6`, so any comparison of raw amounts
 * picks the eighteen-decimal asset every time, whatever it is worth. The gap between the best rate
 * available and what the capital earns today is dimensionless, so it compares.
 *
 * **What that costs, stated rather than hidden.** A large gap on a small balance outranks a small
 * gap on a large one, and by value that is sometimes the wrong call. Ranking by value needs a price
 * for every asset — Chainlink feeds exist and `HelicoOracleBoard` already reads one — and it is
 * `docs/plans/2026-09-10-the-enclave-manages-several-assets.md` step 3 rather than this. Until
 * then the enclave prefers the correction that captures the most yield per unit placed, and the
 * runs are five minutes apart, so the asset that loses this one is first in line for the next.
 *
 * An evacuation outranks every ordinary move regardless of gap: the owner revoked a market and
 * that is an instruction, not an input.
 */
export function decideAcrossAssets(
	config: Config,
	/**
	 * The effective policy **per asset**, because the mandate buffer is not one number for the
	 * account. It is raised by what that asset's own mandates could demand, and sharing one floor
	 * across assets would hold WETH liquid because USDC is committed.
	 */
	policies: Map<string, IdlePolicy>,
	state: AccountState,
	now: number,
): { outcome: Outcome; asset?: Address; side?: AssetState } {
	if (state.agent.toLowerCase() !== config.agent)
		return { outcome: { act: false, reason: 'the account has not nominated this agent' } }

	const considered = state.assets.map((side) => ({
		asset: side.asset,
		side,
		outcome: decideForAsset(
			config,
			policies.get(side.asset.toLowerCase()) ??
				policies.values().next().value ??
				({} as IdlePolicy),
			state.agent,
			side,
			now,
		),
	}))

	const acting = considered.filter((c) => c.outcome.act)
	if (acting.length === 0) {
		// Every asset held, so report the first asset's reason rather than inventing one. With one
		// asset configured this is exactly what the single-asset workflow said.
		const first = considered[0]
		return {
			outcome: first?.outcome ?? { act: false, reason: 'the account holds nothing to place' },
			asset: first?.asset,
			side: first?.side,
		}
	}

	const gap = (c: (typeof considered)[number]): bigint => {
		const o = c.outcome
		if (!o.act) return 0n
		const best = c.side.venues.reduce((m, v) => (v.supplyRateRay > m ? v.supplyRateRay : m), 0n)
		const held = c.side.venues.reduce(
			(m, v) => (v.supplied > 0n && v.supplyRateRay < m ? v.supplyRateRay : m),
			best,
		)
		return best - held
	}

	let winner = acting[0] as (typeof considered)[number]
	for (const c of acting.slice(1)) {
		if (gap(c) > gap(winner)) winner = c
	}
	return { outcome: winner.outcome, asset: winner.asset, side: winner.side }
}

/**
 * Read one account and decide for it.
 *
 * Split out of `onCronTrigger` when the workflow stopped managing a single address. Everything
 * here was inline and per-account already; the only thing that changed is that it is now called
 * once per account rather than once.
 *
 * The mandate-demand read is per account and not shared, because the buffer it raises is a
 * property of *that* account's mandates. Sharing one number across a fleet would hold capital
 * liquid in accounts that owe nothing, and free capital in the one that does.
 */
function evaluate(
	runtime: TeeRuntime<Config>,
	config: Config,
	policy: IdlePolicy,
	account: string,
	now: number,
	signs: boolean,
): Judged {
	const state = readAccountState(
		runtime,
		config.rpcUrl,
		{
			account: account as Address,
			pools: config.pools as Pool[],
			assets: config.assets as Address[],
		},
		{ withNonce: signs, nonceFunction: config.nonceFunction },
	)

	// Ask The Graph what this account's live Aqua mandates could still spend of the asset, and
	// raise the liquid buffer to it. The account is the maker in Aqua's ledger, a swap against one
	// of its mandates is served out of the wallet first, and that question has no on-chain answer
	// — so the index is the only place the number exists. An index that is down, empty or behind
	// never turns the decision into a wrong one: it can only fail to raise a floor, and the run
	// falls back to the owner's own `minIdleAmount`. See `subgraph.ts` for what each of those does
	// to the next swap.
	// One read per asset. The buffer a mandate creates is a claim on *that* token, so a single
	// number shared across assets would hold WETH liquid because USDC is committed — and free
	// USDC because WETH is not.
	const demands = new Map(
		(config.assets as Address[]).map((asset) => [
			asset.toLowerCase(),
			readMandateDemand(runtime, config, account, asset),
		]),
	)
	// Never hashed: the policy hash commits to the secrets the owner published, and this is not
	// those secrets.
	const policies = new Map([...demands].map(([asset, d]) => [asset, withMandateBuffer(policy, d)]))
	// The first asset's numbers are what the run *reports* — the note beside the verdict and the
	// policy the AI is handed. The decision itself uses the map, per asset. With one asset
	// configured the two are the same thing, which is why this reads like the old code.
	const firstAsset = (config.assets as Address[])[0]?.toLowerCase() ?? ''
	const demand = demands.get(firstAsset) as ReturnType<typeof readMandateDemand>
	const effective = policies.get(firstAsset) ?? policy
	const buffer = config.subgraphUrl ? ` [${bufferNote(policy, demand)}]` : ''
	const chosen = decideAcrossAssets({ ...config, account }, policies, state, now)

	return {
		account,
		state,
		effective,
		demand,
		outcome: chosen.outcome,
		asset: chosen.asset,
		buffer,
	}
}

/**
 * The account whose move is worth the most, or nothing when every account is holding.
 *
 * Ranked by amount and not by rate gap, because the amount is the number the single report this
 * run may emit will carry. Two accounts asking for the same amount keep the order they arrived
 * in, which is oldest-first from the index — a tie broken arbitrarily would have the fleet
 * migrate on noise between runs.
 */
function largestMove(judged: Judged[]): Judged | undefined {
	let best: Judged | undefined
	for (const candidate of judged) {
		if (!candidate.outcome.act) continue
		if (!best?.outcome.act) {
			best = candidate
			continue
		}
		if (candidate.outcome.params.amount > best.outcome.params.amount) best = candidate
	}
	return best
}

/**
 * What the run says when nothing moved.
 *
 * The first account's reason and not a summary of all of them: with one account it is the line
 * this workflow has always returned, and with several the others are counted rather than listed,
 * because a run log that grows with the fleet stops being readable exactly when the fleet is
 * worth reading about.
 */
function holdLine(judged: Judged[], fleet: string): string {
	const first = judged[0]
	if (!first) return `HOLD (no account to manage)${fleet}`
	const others = judged.length - 1
	const rest = others > 0 ? `, and ${others} other${others === 1 ? '' : 's'} holding` : ''
	const reason = first.outcome.act ? 'nothing' : first.outcome.reason
	return `HOLD (${reason})${rest}${fleet}${first.buffer}`
}

/**
 * The one secret this workflow reads, holding every value the others used to be.
 *
 * **Measured, against the reference.** Chainlink's Confidential Workflows reference says to fetch
 * several secrets with *"one call per secret"* in TypeScript. That cannot work here: the DON
 * answers **one** secret retrieval per execution and refuses the rest. Two consecutive production
 * runs failed identically at `call 1` while `call 0` succeeded, and before that a single batched
 * call for ten failed outright. One call, one item, is the only shape both facts allow.
 *
 * So the eleven values travel as one JSON document. Nothing downstream changes: this returns the
 * same record keyed by the same ids, and `policyFromSecrets` and the AI client cannot tell the
 * difference.
 *
 * The agent key rides in the same document as the policy, which is worse hygiene than separating
 * them and no worse exposure: the Vault DON releases both only into the enclave, and neither is
 * ever anything but enclave-only. It is here because a limit forced it, not because it is better.
 */
const VAULT_SECRET_ID = 'HELICO_VAULT'

function readSecrets(
	runtime: TeeRuntime<Config>,
	ids: string[],
	namespace: string,
): Record<string, { value: string }> {
	const raw = runtime.getSecret({ id: VAULT_SECRET_ID, namespace }).result().value

	let parsed: Record<string, unknown>
	try {
		parsed = JSON.parse(raw) as Record<string, unknown>
	} catch {
		throw new Error(`${VAULT_SECRET_ID} is not JSON`)
	}

	const all: Record<string, { value: string }> = {}
	for (const id of ids) {
		const value = parsed[id]
		// Named one at a time rather than as a count. A missing `AGENT_KEY` and a missing
		// `AI_API_KEY` are different problems, and the count is what made three wrong hypotheses
		// possible when the DON reported one.
		if (typeof value !== 'string') throw new Error(`${VAULT_SECRET_ID} has no ${id}`)
		all[id] = { value }
	}
	return all
}

/**
 * The asset the decision actually chose, not the first one configured.
 *
 * Its own function because `onCronTrigger` is already at the complexity the linter allows, and
 * because the failure it prevents is quiet: explaining a WETH move with USDC's balances in front
 * of the model produces a correct verdict with a wrong sentence attached to it.
 */
function sideFor(
	state: AccountState,
	asset?: Address,
): { side?: AssetState; balances: IdleBalances } {
	const want = asset?.toLowerCase()
	const side = want
		? (state.assets.find((a) => a.asset.toLowerCase() === want) ?? state.assets[0])
		: state.assets[0]
	const usable = side ? eligibleVenues(side.asset, side.venues).usable : []
	return { side, balances: { idle: side?.idle ?? 0n, venues: usable } }
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
	const secrets = readSecrets(runtime, ids, config.secretsNamespace)
	const policy = policyFromSecrets(secrets)
	const hash = policyHash(policy)
	const now = Math.floor(runtime.now().getTime() / 1000)

	// 2. Refuse thresholds the owner did not publish, before touching the chain. A zero hash in
	//    config means they published none, and then there is nothing to disagree with.
	if (config.policyHash !== ZERO_HASH && hash !== config.policyHash)
		return 'HOLD (policy hash mismatch)'

	// 3. Every account the factory has opened, not only the one config names.
	//
	//    `open` is permissionless, so anyone may create an account at any moment, and until this
	//    existed the enclave managed exactly one address — written into `config.production.json`
	//    by hand. An account somebody else opened sat there with no agent looking at it, which is
	//    worse than not offering the feature: the panel showing it implied otherwise.
	//
	//    The union with config's account, rather than the index alone, is what keeps the demo
	//    account managed on the first run after a deploy — the index lags the chain by a few
	//    blocks, and `subgraphUrl` may be empty, which is still a supported configuration.
	const discovered = readManagedAccounts(runtime, config)
	const managed = accountsToManage(config.account, discovered, config.maxAccountsPerRun)
	const fleet = config.subgraphUrl ? ` [${accountsNote(managed, discovered, config.account)}]` : ''

	// 4. Decide for each of them, and act on one.
	//
	//    **One move leaves per run, and that was already true.** The account's nonce is strictly
	//    sequential, so a second signed call for the same account in one run would be invalid the
	//    moment the first landed. Across accounts the constraint is different and the answer is
	//    the same, deliberately: it has not been established that a run may emit more than one
	//    report, and the way to find out is a rehearsal rather than a guess in production. So
	//    every account is read and judged, the largest move is the one signed, and the rest are
	//    named in the line so a hold is never mistaken for not having looked.
	const judged = managed.map((account) => evaluate(runtime, config, policy, account, now, signs))
	const acting = largestMove(judged)

	if (!acting) return holdLine(judged, fleet)

	const { state, effective, demand, outcome, buffer } = acting
	const chosen = acting
	// Narrows `outcome` for everything below. `largestMove` only ever returns an acting one, so
	// this is a type boundary rather than a runtime possibility.
	if (!outcome.act) return holdLine(judged, fleet)
	const others = judged.length - 1
	const rest = others > 0 ? ` (${others} other account${others === 1 ? '' : 's'} held)` : ''

	// 4b. Ask the model to say why, in the owner's words. Never load-bearing: a missing or
	//     rejected answer changes nothing about what happens next. It is handed every market the
	//     decision was allowed to consider, so a hold about a rate gap has the rates in front of
	//     it.
	const { side, balances } = sideFor(state, chosen.asset)
	const reason = config.aiUrl
		? explain(
				runtime,
				config,
				secrets,
				describeForOwner(
					side?.asset ?? (config.assets as Address[])[0],
					effective,
					balances,
					targetSplit(effective, balances),
					outcome,
					// The model is handed the buffer it is explaining *and* where that buffer came
					// from. Without it, a floor raised by a mandate reads as the owner's own number
					// and the sentence about the policy is wrong.
					config.subgraphUrl ? { policy, demand } : undefined,
				),
			)
		: undefined
	const because = reason ? ` — ${reason}` : ''

	// The market is named in the line, not only in the report: with several to choose between,
	// "SUPPLY 800000000" no longer says what happened.
	const move = outcome.params.supply
		? `SUPPLY ${outcome.params.amount} to ${outcome.params.pool}`
		: `WITHDRAW ${outcome.params.amount} from ${outcome.params.pool}`

	// 5. Cross back with the move only.
	if (signs) {
		const statement = await signAndReport(runtime, config, secrets, hash, {
			account: acting.account as Address,
			nonce: state.nonce,
			params: outcome.params,
		})
		// The buffer note goes before the statement, never after: `rehearse-idle.sh` reads the
		// JSON out of this line with a greedy match to the last `}`, and prose behind it would be
		// swallowed into what it tries to parse.
		return `${move}${rest}${fleet}${buffer} ${statement}${because}`
	}
	const txHash = deliver(runtime.usingTheDons(), config, encodeReport(true, hash, outcome.params))
	return `${move}${rest}${fleet}${buffer} tx ${txHash}${because}`
}

/**
 * Sign the move inside the enclave, hand it to the DON, and give back the statement to print.
 *
 * Extracted from `onCronTrigger` rather than left inline, and not only for its size: the two
 * throws here are the enclave refusing to sign something it cannot sign correctly, which is a
 * different kind of decision from the branches above them. Those choose *whether* to move; these
 * two say the run is broken.
 *
 * The key is read here and never crosses out. The statement does — it is public by design once
 * relayed, and it is what the DON attests to.
 */
async function signAndReport(
	runtime: TeeRuntime<Config>,
	config: Config,
	secrets: Record<string, { value: string }>,
	policyHashUsed: Hex,
	move: { account: Address; nonce: bigint | undefined; params: IdleMoveParams },
): Promise<string> {
	const key = secrets[config.agentKeySecretId]?.value as Hex | undefined
	if (!key) throw new Error(`Secret ${config.agentKeySecretId} is missing`)
	if (move.nonce === undefined) throw new Error('The account did not answer the nonce read')

	const auth: Authorisation = {
		params: move.params,
		policyHash: policyHashUsed,
		nonce: move.nonce,
	}
	const domain: IdleMoveDomain = {
		name: config.domainName,
		version: config.domainVersion,
		chainId: config.chainId as number,
		// **The account that acts, not the one config names.** `HelicoAccount.domainSeparator`
		// is built from `address(this)`, so a statement signed under any other address recovers
		// to something that is not the agent and the account refuses it. Since `account` now
		// defaults to the zero address, using it here would sign every ordinary run against
		// `0x0000…0000` and no signature would ever be usable.
		//
		// Caught by @rifkyeasy in review. The test that had covered signing agreed with the bug
		// rather than measuring it: it built its expected domain from the same `config.account`
		// expression the code used, so both were wrong together.
		verifyingContract: move.account,
	}
	const { signature, signer } = await signIdleMove(key, domain, auth)
	runtime
		.usingTheDons()
		.report({
			encodedPayload: hexToBase64(encodeAuthorisation(auth, signature)),
			encoderName: 'evm',
			signingAlgo: 'ecdsa',
			hashingAlgo: 'keccak256',
		})
		.result()
	return authorisationJson(auth, signature, signer)
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
