import { bytesToBase64, cre, ok, type TeeRuntime, text } from '@chainlink/cre-sdk'
import type { IdlePolicy } from './policy'

/**
 * The buffer, sized by what the maker's Aqua mandates could actually demand.
 *
 * `policy.minIdleAmount` is the owner saying how much must stay liquid, and every run before this
 * one took that number as the whole answer. It is not: the reason the buffer exists is that a
 * swap taken against one of the maker's Aqua mandates is served out of the wallet first — the
 * account **is** the maker in Aqua's ledger — and `HelicoMandateSwap._cover` only unwinds a
 * lending position when the wallet cannot pay. That unwind is the slow path, it pays for a
 * `withdraw` inside somebody else's swap, and `_venueFor` can refuse it outright when no venue
 * can cover or the maker has borrowed. So the buffer ought to follow the mandates, and with a
 * fixed secret it does not: ship a larger mandate and the number the owner set stays where it was.
 *
 * **The question has no on-chain answer.** Aqua's `_balances` is `private` and four levels deep —
 * maker, app, strategyHash, token — `rawBalances` needs a hash you already hold, and not one
 * parameter of Aqua's four events is `indexed`, so logs cannot be filtered by maker either. The
 * subgraph's own schema opens with exactly this, and `Balance.amount` is documented there as
 * "the number an agent has to know before acting". That is what makes The Graph load-bearing in
 * this workflow rather than decorative: without an index there is no second way to get it.
 *
 * **Why the query is copied out of `@helico/plugin-thegraph` rather than imported.** That package
 * owns this question for the browser and the tests, and `makerMandates` answers it — but it
 * cannot be called from here. It takes a `fetch`-shaped implementation and is `async`; the
 * enclave has no `fetch`, no `Response` to build one out of, and CRE's HTTP capability is
 * synchronous (`sendRequest(...).result()`) over a base64 body. And it asks for the whole mandate
 * including `strategy` verbatim, which is the one field that cannot fit: measured against the
 * live subgraph on 8 September 2026, one maker's 38 mandates came back as **41,303 bytes**
 * because each carries 578 hex characters of strategy — 1.09 kB a mandate, so a maker with ~460
 * of them would already exceed the enclave's `ConfHTTP resp=500kb`, and the 1000-row page that
 * package deliberately requests would be over a megabyte. What is reused is what matters: the
 * spendability rule below is Aqua's three-state sentinel, copied from `toMandates`, and the
 * top-level query is the same shape and for the same reason.
 *
 * **What a wrong answer can and cannot do.** The number is only ever allowed to *raise* the
 * floor — see `withMandateBuffer` — so the failure modes are bounded and none of them is a loss:
 *
 *  - **Unreachable, refused, or malformed.** The floor stays the owner's own `minIdleAmount`,
 *    which is what every run did before this existed, and the verdict says so.
 *  - **Empty.** A maker with no live mandate in this asset demands nothing, and a floor of zero
 *    raises nothing. An empty answer and an absent one produce the same buffer and are reported
 *    differently on purpose: one is a fact about the maker, the other is a fact about the index.
 *  - **Lagging.** An indexer behind the chain under-reports, so the buffer comes out too small
 *    and more capital is supplied than ideal. The next swap then takes the path it takes today —
 *    `_cover` unwinds inside the swap — which is slower and can be refused, but is the existing
 *    behaviour rather than a new failure. Over-reporting is the other direction and costs yield,
 *    not capital: an absurd floor parks everything idle, and idle is where the account starts.
 *
 * Nothing here decides anything. It returns a number the decision may raise a floor with.
 */

/** What the enclave needs to reach the index. Both are public config, like `rpcUrl`. */
export type SubgraphConfig = {
	/** The Aqua subgraph's GraphQL endpoint. Empty turns the whole step off. */
	subgraphUrl: string
	subgraphTimeoutSeconds: number
}

/**
 * The most rows one request may ask for, and the bound the 500 kB response limit needs.
 *
 * The Graph caps a page at 1000 whatever is asked for, so this is also the largest useful
 * request. A row here is `{"amount":"…","tokensCount":n}` — at most about 110 bytes with a
 * full `uint256` and a three-digit count — so a thousand of them is roughly 110 kB, comfortably
 * inside the `ConfHTTP resp=500kb` the simulator prints. `subgraph.test.ts` builds that worst
 * case and measures it rather than trusting the arithmetic here.
 *
 * There is no second page. A maker whose live balances in one asset overflow a thousand rows
 * gets a sum over the largest thousand, which is a **floor** on what the mandates could demand
 * — and a floor is the only thing this number is ever used as. `complete: false` carries that
 * into the verdict instead of hiding it.
 */
export const MAX_BALANCE_ROWS = 1000

/**
 * The most accounts one request may ask for.
 *
 * A row is `{"id":"0x…","owner":"0x…"}` — 90 bytes with both addresses — so a thousand is 90 kB,
 * inside the same `ConfHTTP resp=500kb` the balance query is sized against. The Graph caps a page
 * at a thousand regardless of what is asked, so this is also the largest request that means
 * anything.
 *
 * Ordered oldest first, so a page that does not hold everything holds the accounts that have
 * existed longest — the ones most likely to hold capital. `complete: false` carries the
 * difference into the run log rather than hiding it.
 */
export const MAX_ACCOUNT_ROWS = 1000

/** Config's way of saying it names no anchor. Not imported from viem: this file is pure. */
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`

/**
 * Every account the factory has opened.
 *
 * The enclave managed exactly one account until this existed: the address written into
 * `config.production.json` by hand. `open` is permissionless, so anyone may create an account at
 * any time, and nothing enumerated the ones we did not create — an account a stranger opened sat
 * there with no agent looking at it.
 *
 * `AccountOpened` indexes the owner, so this is recoverable from `eth_getLogs` alone. It is asked
 * of the index instead because the workflow already queries this endpoint for mandate demand, and
 * a log scan from the factory's deployment block grows without bound while this stays one request.
 */
export const MANAGED_ACCOUNTS = `
  query Accounts($first: Int!) {
    accounts(orderBy: openedAtBlock, orderDirection: asc, first: $first) {
      id
      owner
    }
  }
`

/** The accounts this run will consider, or why the list is only what config named. */
export type ManagedAccounts =
	| { known: false; reason: string }
	| {
			known: true
			/** Account addresses, lower-cased, oldest first. */
			accounts: string[]
			/** False when the page came back full, so there are accounts this run cannot see. */
			complete: boolean
	  }

type AccountsBody = {
	data?: { accounts?: { id: string; owner: string }[] }
	errors?: { message?: string }[]
}

/** The request, split out so a test can assert its shape without a runtime. */
export function accountsHttpRequest(config: SubgraphConfig): {
	url: string
	method: string
	body: string
	multiHeaders: Record<string, { values: string[] }>
	timeout: string
} {
	const body = JSON.stringify({
		query: MANAGED_ACCOUNTS,
		variables: { first: MAX_ACCOUNT_ROWS },
	})
	return {
		url: config.subgraphUrl,
		method: 'POST',
		body: bytesToBase64(new TextEncoder().encode(body)),
		multiHeaders: { 'Content-Type': { values: ['application/json'] } },
		timeout: `${config.subgraphTimeoutSeconds}s`,
	}
}

/**
 * The list, and every way a 200 can fail to be one. Pure.
 *
 * A row without a usable `id` fails the whole read rather than being skipped, for the reason
 * `demandFromResponse` gives: a partial list is indistinguishable from a smaller one, and this
 * list decides which owners get an agent this run.
 */
export function accountsFromResponse(raw: string): ManagedAccounts {
	let body: AccountsBody
	try {
		body = JSON.parse(raw) as AccountsBody
	} catch {
		return { known: false, reason: 'answered something that is not JSON' }
	}
	if (body.errors?.length) {
		return {
			known: false,
			reason: `answered ${body.errors.map((e) => e.message ?? 'an error').join('; ')}`,
		}
	}
	const rows = body.data?.accounts
	if (!rows) return { known: false, reason: 'answered a 200 with no accounts' }

	const accounts: string[] = []
	for (const row of rows) {
		if (typeof row.id !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(row.id)) {
			return { known: false, reason: 'answered an account that is not an address' }
		}
		accounts.push(row.id.toLowerCase())
	}
	return { known: true, accounts, complete: rows.length < MAX_ACCOUNT_ROWS }
}

/**
 * Ask the index which accounts exist. Never throws.
 *
 * Every failure becomes `known: false`, and the caller falls back to the account config names.
 * That fallback is why an index being down cannot stop the demo account being managed: the run
 * degrades to what it did before this existed rather than to nothing.
 */
export function readManagedAccounts(
	runtime: TeeRuntime<unknown>,
	config: SubgraphConfig,
): ManagedAccounts {
	if (!config.subgraphUrl) return { known: false, reason: 'is not configured' }
	try {
		const response = new cre.capabilities.HTTPClient()
			.sendRequest(runtime, accountsHttpRequest(config))
			.result()
		if (!ok(response)) return { known: false, reason: `answered HTTP ${response.statusCode}` }
		return accountsFromResponse(text(response))
	} catch {
		return { known: false, reason: 'could not be reached' }
	}
}

/**
 * The accounts this run manages: everything the index knows, plus the one config names.
 *
 * The union and not the index alone, for two reasons that both matter on the first run after a
 * deploy. The index lags the chain by a few blocks, so an account opened a moment ago is real and
 * absent. And `subgraphUrl` may be empty, which is a supported configuration — the workflow ran
 * that way before any of this.
 *
 * Lower-cased and de-duplicated, because the same account reaching this from both sources with
 * different capitalisation would be read twice and signed for twice.
 */
export function accountsToManage(configured: string, discovered: ManagedAccounts): string[] {
	const anchor = configured.toLowerCase()
	// The zero address means no anchor was set, which is the ordinary configuration: the index
	// sees every account the factory opened, so naming one here is not how an account gets
	// managed. Including it would have the run read state for an address with no code, decide
	// about nothing, and count it in the fleet — three lies for the price of a default.
	const anchored = anchor !== ZERO_ADDRESS
	const seen = new Set<string>(anchored ? [anchor] : [])
	const all = anchored ? [anchor] : []
	if (discovered.known) {
		for (const account of discovered.accounts) {
			if (seen.has(account)) continue
			seen.add(account)
			all.push(account)
		}
	}
	return all
}

/** One line for the run log saying how many accounts were considered, and where the list came from. */
export function accountsNote(
	managed: string[],
	discovered: ManagedAccounts,
	configured: string,
): string {
	const plural = managed.length === 1 ? '' : 's'
	// Whether config named an anchor is read from config, not inferred from how many accounts
	// came back. The inference is wrong in the case that matters most — an anchor the index also
	// returned makes the two lists the same length, and the note would then say the anchor was
	// not set on exactly the runs where it was doing its job.
	const anchored = configured.toLowerCase() !== ZERO_ADDRESS
	if (!discovered.known) {
		const source = anchored ? 'config only' : 'nothing to manage'
		return `${managed.length} account${plural}: ${source}, the subgraph ${discovered.reason}`
	}
	const page = discovered.complete ? '' : '; a full page, so there are more'
	const from = anchored
		? `${discovered.accounts.length} indexed plus the one in config`
		: `${discovered.accounts.length} indexed`
	return `${managed.length} account${plural}: ${from}${page}`
}

/**
 * What the maker's live mandates could still spend of one token.
 *
 * A top-level `balances` query and not `mandates { balances }`, for the reason
 * `@helico/plugin-thegraph` gives about `maker { mandates }`: a nested list caps at 100 with no
 * `pageInfo` and no cursor, so nothing in the response distinguishes 100 from 100 of 5000. Aqua
 * lets a mandate ship up to 254 tokens, so that cap is reachable here rather than theoretical.
 *
 * `active: true` filters mandates the ledger says are entirely spent or docked. It is not the
 * spendability rule — that is per token and is applied to `tokensCount` below, because
 * `Mandate.active` is true while *at least one* token under it is still spendable.
 *
 * Ordered by amount, descending, so that a page which does not hold everything holds the part
 * that matters most: the largest balances are the ones that could demand the most liquidity.
 */
export const MANDATE_DEMAND = `
  query Demand($maker: Bytes!, $token: Bytes!, $first: Int!) {
    balances(
      where: { token: $token, mandate_: { maker: $maker, active: true } }
      orderBy: amount
      orderDirection: desc
      first: $first
    ) {
      amount
      tokensCount
    }
  }
`

/**
 * What the index said, or why it said nothing.
 *
 * `known: false` is not an error state the run has to handle — it is the answer "the policy floor
 * stands", which is a complete and safe answer. The reason is carried so the verdict can say
 * which of the two buffers it used.
 */
export type MandateDemand =
	| { known: false; reason: string }
	| {
			known: true
			/** Summed over spendable balances, in the asset's own units. */
			amount: bigint
			/** How many balances went into it. Zero is a maker with nothing live in this asset. */
			balances: number
			/** False when the page came back full, so `amount` is a floor rather than the total. */
			complete: boolean
	  }

type Body = {
	data?: { balances?: { amount: string; tokensCount: number }[] }
	errors?: { message?: string }[]
}

/**
 * The request the HTTP capability is handed, split out so a test can assert its shape without a
 * runtime — the same reason `completionHttpRequest` is split out in `ai.ts`, and for the same
 * bug: `timeout` is a `google.protobuf.Duration`, which in JSON is the **string** `"30s"`. The
 * object form type-checks and is thrown away at run time.
 *
 * No `Authorization` header. This is a Subgraph Studio development endpoint, which takes no key
 * and is the only address our subgraph has — it is deployed, not published to the network — and
 * a bearer header carrying an empty key is a request that says "authenticated" while carrying
 * nothing. `@helico/plugin-thegraph`'s `query` draws the same line.
 */
export function demandHttpRequest(
	config: SubgraphConfig,
	maker: string,
	asset: string,
): {
	url: string
	method: string
	body: string
	multiHeaders: Record<string, { values: string[] }>
	timeout: string
} {
	// Lower-cased because the subgraph stores addresses as lower-case `Bytes`. A checksummed
	// address matches nothing and comes back as an **empty list rather than an error**, so a
	// maker with fifty mandates would read as a maker with none. Config already lower-cases
	// both of these; doing it again costs nothing and does not depend on that staying true.
	const body = JSON.stringify({
		query: MANDATE_DEMAND,
		variables: {
			maker: maker.toLowerCase(),
			token: asset.toLowerCase(),
			first: MAX_BALANCE_ROWS,
		},
	})
	return {
		url: config.subgraphUrl,
		method: 'POST',
		// Not `btoa`: the WASM runtime the workflow compiles into does not provide it, and the
		// failure is `not a function` at run time with every unit test still green.
		body: bytesToBase64(new TextEncoder().encode(body)),
		multiHeaders: { 'Content-Type': { values: ['application/json'] } },
		timeout: `${config.subgraphTimeoutSeconds}s`,
	}
}

/**
 * The sum, and every way a 200 can fail to be an answer. Pure.
 *
 * A GraphQL endpoint answers `200 OK` with an `errors` array for a query it refused — checked
 * against the live subgraph, which returns exactly that for a bad `where` argument — so the
 * status alone reports success for a response carrying no data.
 *
 * A malformed amount fails the whole read rather than being skipped. A partial sum here would be
 * indistinguishable from a smaller portfolio, and the point of this number is that it is the one
 * an agent has to know before acting.
 */
export function demandFromResponse(raw: string): MandateDemand {
	let body: Body
	try {
		body = JSON.parse(raw) as Body
	} catch {
		return { known: false, reason: 'answered something that is not JSON' }
	}
	if (body.errors?.length) {
		return {
			known: false,
			reason: `answered ${body.errors.map((e) => e.message ?? 'an error').join('; ')}`,
		}
	}
	const rows = body.data?.balances
	if (!rows) return { known: false, reason: 'answered a 200 with no balances' }

	let amount = 0n
	let balances = 0
	try {
		for (const row of rows) {
			// Aqua's own three-state sentinel, copied from `toMandates` in
			// `@helico/plugin-thegraph`: 0 never shipped, 1–254 active, 255 docked. `dock` zeroes
			// the ledger on chain and emits nothing per token, so an amount alone cannot say
			// whether a token is still spendable — only this can.
			if (!(row.tokensCount > 0 && row.tokensCount < 255)) continue
			amount += BigInt(row.amount)
			balances += 1
		}
	} catch {
		return { known: false, reason: 'answered an amount that is not a number' }
	}
	return { known: true, amount, balances, complete: rows.length < MAX_BALANCE_ROWS }
}

/**
 * Ask the index what the maker's mandates could demand. Never throws.
 *
 * Every failure becomes `known: false`, because there is no failure here that should stop a run:
 * the owner's own floor is a complete answer to "how much must stay liquid", and it is the answer
 * this workflow used before the subgraph was in the loop at all.
 */
export function readMandateDemand(
	runtime: TeeRuntime<unknown>,
	config: SubgraphConfig,
	maker: string,
	asset: string,
): MandateDemand {
	if (!config.subgraphUrl) return { known: false, reason: 'is not configured' }
	try {
		const response = new cre.capabilities.HTTPClient()
			.sendRequest(runtime, demandHttpRequest(config, maker, asset))
			.result()
		if (!ok(response)) return { known: false, reason: `answered HTTP ${response.statusCode}` }
		return demandFromResponse(text(response))
	} catch {
		// A body over `ConfHTTP resp=500kb`, a timeout, a DNS failure — from in here they are one
		// fact: the index did not answer this run, and the policy floor stands.
		return { known: false, reason: 'could not be reached' }
	}
}

/**
 * The policy with its buffer raised to what the mandates could demand, and **never lowered**.
 *
 * The owner's `minIdleAmount` is a minimum they stated; a mandate they shipped is a promise they
 * made. Both have to hold, so the buffer is the larger of the two and an index reporting less
 * than the owner asked for changes nothing.
 *
 * **The result must never be hashed.** `policyHash` commits to the secrets the owner published,
 * and this is not those secrets — hashing it would make every run with a live mandate look like a
 * policy edited underneath the workflow. `onCronTrigger` computes the hash before this is
 * applied, which is the ordering that keeps the two apart.
 */
export function withMandateBuffer(policy: IdlePolicy, demand: MandateDemand): IdlePolicy {
	if (!demand.known || demand.amount <= policy.minIdleAmount) return policy
	return { ...policy, minIdleAmount: demand.amount }
}

/**
 * One line for the run log saying which buffer was used and where it came from.
 *
 * Both numbers, always, whichever won. A verdict that printed only the buffer it used could not
 * be told apart from one that never asked, and "the subgraph was down" is the fact most worth
 * having when a run holds capital that a mandate later cannot cover.
 */
export function bufferNote(policy: IdlePolicy, demand: MandateDemand): string {
	if (!demand.known) {
		return `buffer ${policy.minIdleAmount}: policy floor only, the subgraph ${demand.reason}`
	}
	const floor = demand.amount > policy.minIdleAmount ? demand.amount : policy.minIdleAmount
	const page = demand.complete ? '' : '; a full page, so there may be more'
	const plural = demand.balances === 1 ? '' : 's'
	return `buffer ${floor}: policy floor ${policy.minIdleAmount}, ${demand.balances} live Aqua balance${plural} could demand ${demand.amount}${page}`
}
