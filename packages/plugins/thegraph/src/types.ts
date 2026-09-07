/** A subgraph, addressed either by its network id or by a Subgraph Studio URL. */
export type Subgraph = {
	/** Human name, for errors and logs. Never sent anywhere. */
	name: string
	/** The id shown in the Graph Explorer, not the deployment id. Empty for a Studio endpoint. */
	id: string
	chainId: number
	/**
	 * A Subgraph Studio development endpoint, which addresses a subgraph by URL rather than by
	 * id and takes no key. Set it and `query` goes there instead of the gateway.
	 *
	 * The two are not interchangeable. The gateway serves subgraphs *published to the network*
	 * and authenticates every request; Studio serves what an account has *deployed*, is rate
	 * limited, and is what The Graph's own qualification names for subgraphs. Ours is deployed,
	 * not published, so this is the only address it has.
	 */
	url?: string
}

/**
 * The two v4 subgraphs published for the chains Helico targets.
 *
 * Ids come from the Graph Explorer. They are recorded here rather than passed in because a wrong
 * id fails at query time with a message about authorisation rather than about the id — see the
 * note in `gateway()`.
 */
export const UNISWAP_V4: Record<number, Subgraph> = {
	42161: {
		name: 'Uniswap v4 — Arbitrum One',
		id: 'D1VHPU6cXXSC8eaApWCjCnPcTZQFSYCpGoDAvt4ogDWh',
		chainId: 42161,
	},
	8453: {
		name: 'Uniswap v4 — Base',
		id: '2L6yxqUZ7dT6GWoTy9qxNBkf9kEk65me3XPMvbGsmJUZ',
		chainId: 8453,
	},
}

/**
 * What an hour of a pool looked like. A subset of the subgraph's `PoolHourData`: only the fields
 * a decision can act on, so a schema change elsewhere cannot silently widen what we depend on.
 */
export type PoolHour = {
	/** Unix seconds at the start of the hour. */
	periodStartUnix: number
	/** The pool's tick at that hour, or null when the subgraph recorded none. */
	tick: number | null
	feesUSD: number
	volumeUSD: number
	tvlUSD: number
}

/**
 * What the enclave cannot see for itself.
 *
 * `readChainState` reads one instant. Every question worth asking before moving a range is
 * historical — whether the price drifted or merely oscillated across the band, and whether the
 * pool earns enough to pay for the move — and none of it has an on-chain answer.
 */
export type PoolHistory = {
	/** How many hours were actually returned. Fewer than asked for is normal for a young pool. */
	hours: number
	/** Lowest and highest tick observed. Equal when only one hour had a tick. */
	tickMin: number
	tickMax: number
	/** Summed over the window. */
	feesUSD: number
	volumeUSD: number
	/** The most recent hour's total value locked, or 0 when the window was empty. */
	tvlUSD: number
}

/**
 * Helico's own subgraph: Aqua on Arbitrum One.
 *
 * This is the one the submission rests on. `UNISWAP_V4` above answers questions about a pool;
 * this answers the question Aqua cannot answer about itself — which mandates a maker has, and
 * what is left in each — because `_balances` is private and four levels deep and not one of the
 * four events indexes a parameter.
 *
 * The URL is a default, not a secret. A Studio development endpoint carries no key, and a judge
 * who clones this repository can query it with `curl` and no account. Override it with
 * `GRAPH_STUDIO_URL` when pointing at another deployment; the override belongs to whichever app
 * is doing the reading, because this package never touches `process.env` — the enclave has no
 * environment to read.
 */
export const HELICO_AQUA: Record<number, Subgraph> = {
	42161: {
		name: 'Helico — Aqua on Arbitrum One',
		id: '',
		chainId: 42161,
		url: 'https://api.studio.thegraph.com/query/1758877/helico-arbitrum-one/version/latest',
	},
}

/** What is left of one token under one mandate, as Aqua's ledger holds it. */
export type MandateBalance = {
	token: string
	amount: bigint
	/**
	 * Whether this token can still be spent, from Aqua's own three-state sentinel rather than
	 * from the amount. A docked mandate has its ledger zeroed on chain and emits no per-token
	 * event, so an amount of zero and a revocation look identical from the outside.
	 */
	spendable: boolean
	totalPulled: bigint
	totalPushed: bigint
}

/** One strategy a maker shipped, with its ledger. `strategy` is undecoded on purpose. */
export type Mandate = {
	strategyHash: string
	/** The bytes the maker shipped, verbatim. Each app owns the ABI that decodes them. */
	strategy: string
	active: boolean
	/** The app the maker gave spending rights to. */
	app: string
	movementCount: number
	shippedAt: number
	balances: MandateBalance[]
}

/** Everything a maker is permitted to do, which is what an agent must know before it acts. */
export type MakerMandates = {
	maker: string
	mandates: Mandate[]
	/** Mandates not docked. */
	active: number
	/** Token address to the total still spendable across every active mandate. */
	spendable: Map<string, bigint>
}
