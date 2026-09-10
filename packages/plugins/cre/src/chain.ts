import { bytesToBase64, cre, ok, type TeeRuntime, text } from '@chainlink/cre-sdk'
import {
	type Address,
	decodeFunctionResult,
	encodeFunctionData,
	type Hex,
	parseAbi,
	zeroAddress,
} from 'viem'
import {
	accountAbi,
	erc20Abi,
	lendingVenueAbi,
	receiptAbi,
	reserveDataAbi,
	sharePricedReceiptAbi,
} from './abi'

export type Call = { to: Address; data: Hex }

/**
 * One JSON-RPC batch of `eth_call`s over the HTTP capability, from inside the enclave. Results
 * come back in call order; any error in the batch throws, since a partial view is worse than
 * no view.
 */
export function ethCallBatch(runtime: TeeRuntime<unknown>, rpcUrl: string, calls: Call[]): Hex[] {
	const body = JSON.stringify(
		calls.map((call, id) => ({ jsonrpc: '2.0', id, method: 'eth_call', params: [call, 'latest'] })),
	)
	const response = new cre.capabilities.HTTPClient()
		.sendRequest(runtime, {
			url: rpcUrl,
			method: 'POST',
			body: bytesToBase64(new TextEncoder().encode(body)),
			multiHeaders: { 'Content-Type': { values: ['application/json'] } },
		})
		.result()
	if (!ok(response)) throw new Error(`RPC returned status ${response.statusCode}`)
	const parsed: unknown = JSON.parse(text(response))
	if (!Array.isArray(parsed)) {
		throw new Error(`RPC did not answer the batch: ${JSON.stringify(parsed).slice(0, 200)}`)
	}
	const replies = parsed as { id: number; result?: Hex; error?: { message?: string } }[]
	return calls.map((_, id) => {
		const reply = replies.find((r) => r.id === id)
		if (!reply?.result)
			throw new Error(`eth_call ${id} failed: ${reply?.error?.message ?? 'no result'}`)
		return reply.result
	})
}

export type Addresses = {
	/** The `HelicoAccount` proxy whose capital this run is about. */
	account: Address
	/**
	 * The lending markets to compare. Each must be one the owner allowlisted, which is read below
	 * rather than assumed, and each must be a real Aave-family market: a pool that cannot answer
	 * these reads fails the whole run, because a view missing one market's rate is a view that
	 * would pick the best of the rest and call it the best.
	 */
	pools: Pool[]
	/** The ERC-20s being placed, in the order the owner wrote them. */
	assets: Address[]
}

/**
 * How a market's receipt expresses what it is worth, which decides how its balance is read.
 *
 * Mirrors `ReceiptKind` in `contracts/src/ReceiptMath.sol` deliberately, and for the reason that
 * file gives: two definitions of what a receipt means would drift, and the one that drifted would
 * be the one somebody's capital was already sitting behind.
 *
 * - `rebasing` — an Aave aToken. The balance grows and is already the position, in the asset's units.
 * - `share-priced` — a Compound or Morpho venue. The balance is a share count that stays put while
 *   its price rises, so it has to be converted before anything compares it to an amount of asset.
 */
export type ReceiptKind = 'rebasing' | 'share-priced'

/** One market the owner permitted, and what kind of receipt it hands back. */
export type Pool = {
	address: Address
	kind: ReceiptKind
	/**
	 * The assets this market lists, when it does not list all of them. Omitted means every asset
	 * the account is configured for.
	 *
	 * **Why this had to exist before ETH could earn.** Aave's Pool serves every reserve, so one
	 * address answers for USDC and WETH alike and the first configuration never needed to say
	 * otherwise. A `CompoundVenue` or `MorphoVenue` is the opposite: one venue holds exactly one
	 * market, and `getReserveAToken` on the wrong asset **reverts** rather than returning zero.
	 * Since a failed call fails the whole run — deliberately, see `readAccountState` — a second
	 * asset added to a configuration holding single-asset venues kills every run rather than
	 * earning anything.
	 *
	 * Measured on Arbitrum One before this was written, not assumed: Aave answered
	 * `getReserveAToken` for both USDC and WETH; each of the three venues answered for its own
	 * asset and reverted on the other.
	 *
	 * **Declared rather than discovered.** Treating a revert as "this market does not list this
	 * asset" would work and would be wrong: an RPC that drops a call, a venue that is paused, and
	 * a market that genuinely does not hold the asset would all arrive as the same silence, and
	 * the run would carry on comparing whatever was left. Written down, a revert stays a failure.
	 */
	assets?: Address[]
}

/** Whether a market is one this asset should be read at. A market with no list serves them all. */
export function listsAsset(pool: Pool, asset: Address): boolean {
	if (pool.assets === undefined) return true
	const want = asset.toLowerCase()
	return pool.assets.some((a) => a.toLowerCase() === want)
}

/** One market, as this account sees it. */
export type VenueState = {
	pool: Address
	/** Whether the owner still allows this market. */
	venuePermitted: boolean
	/** The receipt this market issues for this asset, asked of the market rather than the receipt. */
	receipt: Address
	/** What that receipt says it is for. Zero when the market does not list the asset. */
	receiptAsset: Address
	/** How this market's receipt expresses its value, carried through from the config. */
	kind: ReceiptKind
	/**
	 * The account's position at this market, **in the asset's units** — which for a share-priced
	 * receipt is not what `balanceOf` returned. Everything downstream compares this to amounts of
	 * asset and passes it to `withdrawIdle`, which takes an amount of asset, so the conversion has
	 * to happen here or not at all.
	 */
	supplied: bigint
	/**
	 * The raw receipt balance, before conversion. Equal to `supplied` for a rebasing receipt.
	 *
	 * Kept because the two are different questions and only one of them is an amount of money: a
	 * check on whether the position is empty wants this, and anything sizing a withdrawal wants
	 * `supplied`.
	 */
	receiptBalance: bigint
	/** What this market can pay out right now. */
	venueLiquidity: bigint
	/** Aave's `currentLiquidityRate`, a ray. */
	supplyRateRay: bigint
}

/** One asset the account holds, and every market that will take it. */
export type AssetState = {
	asset: Address
	/** What the account holds liquid in this asset, in the asset's own units. */
	idle: bigint
	/**
	 * One entry per market that **lists this asset**, in the order the owner wrote them. A market
	 * scoped to other assets is absent rather than present and empty, because it is not a market
	 * this asset could have gone to and a comparison should not see it at all.
	 */
	venues: VenueState[]
}

export type AccountState = {
	/** Who the account will currently accept an idle move from. Zero means nobody. */
	agent: Address
	/**
	 * One entry per configured asset, in the order the owner wrote them.
	 *
	 * A run reads every asset before deciding anything, which is the whole reason this is one
	 * workflow rather than one per asset: only a view that holds all of them can answer "which
	 * move is worth the one move this run gets".
	 */
	assets: AssetState[]
	/** The account's signature nonce, read only when the enclave signs. */
	nonce?: bigint
}

/** The reads made per market in the first batch, in the order they are made. */
const VENUE_READS = 4

/**
 * Everything the decision needs, in two batches whatever the number of markets.
 *
 * There are two and not one because of a rule the contracts state plainly: the market is asked
 * which receipt it issues, never the receipt asked which market it belongs to. A forged receipt
 * returns the real pool's address and passes the second check while failing the first, so the
 * receipt's address has to come out of the first batch before its balance can be read in the
 * second. A market that does not list the asset at all contributes nothing to the second batch,
 * and when none of them lists it there is no second batch; the caller holds on that.
 *
 * Batching every market together rather than one at a time is what keeps the enclave's round
 * trips at two: comparing markets should cost more calls, not more waiting.
 */
export function readAccountState(
	runtime: TeeRuntime<unknown>,
	rpcUrl: string,
	{ account, pools, assets }: Addresses,
	options: { withNonce?: boolean; nonceFunction?: string } = {},
): AccountState {
	// `HelicoAccount.nonce` takes no argument, unlike the vault's `nonces(address)`: one account
	// belongs to one owner, so there is nobody to ask about.
	const nonceAbi = parseAbi([
		`function ${options.nonceFunction ?? 'nonce'}() view returns (uint256)`,
	])
	const nonceCall = options.withNonce
		? [{ to: account, data: encodeFunctionData({ abi: nonceAbi }) }]
		: []

	// Which markets are read for which asset. A market that does not list an asset is not asked
	// about it — `getReserveAToken` on the wrong asset reverts, and one revert fails the batch.
	const perAsset = assets.map((asset) => ({
		asset,
		pools: pools.filter((pool) => listsAsset(pool, asset)),
	}))

	// One batch for every asset and every market, rather than one batch per asset. Comparing more
	// things should cost more calls, not more waiting — and the whole reason this is one workflow
	// is that a single view holds all of it before anything is decided.
	const first = ethCallBatch(runtime, rpcUrl, [
		{ to: account, data: encodeFunctionData({ abi: accountAbi, functionName: 'agent' }) },
		...perAsset.flatMap(({ asset, pools: listed }): Call[] => [
			{
				to: asset,
				data: encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
			},
			...listed.flatMap((pool): Call[] => [
				{
					to: account,
					data: encodeFunctionData({
						abi: accountAbi,
						functionName: 'permittedVenue',
						args: [pool.address],
					}),
				},
				{
					to: pool.address,
					data: encodeFunctionData({
						abi: lendingVenueAbi,
						functionName: 'getReserveAToken',
						args: [asset],
					}),
				},
				{
					to: pool.address,
					data: encodeFunctionData({
						abi: lendingVenueAbi,
						functionName: 'getVirtualUnderlyingBalance',
						args: [asset],
					}),
				},
				{
					to: pool.address,
					data: encodeFunctionData({
						abi: reserveDataAbi,
						functionName: 'getReserveData',
						args: [asset],
					}),
				},
			]),
		]),
		...nonceCall,
	])

	const agentHex = first[0] as Hex
	const nonceHex = options.withNonce ? first[first.length - 1] : undefined

	// A cursor rather than a stride. Every asset used to spend the same number of calls, so its
	// slice could be multiplied out; now an asset's slice is only as long as the number of markets
	// that list it, and a market scoped to WETH contributes nothing to USDC's.
	let cursor = 1

	// The markets' own answers, per asset — everything except what each receipt knows about itself.
	const partial = perAsset.map(({ asset, pools: listed }) => {
		const idleHex = first[cursor++] as Hex
		return {
			asset,
			idle: decodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', data: idleHex }),
			venues: listed.map((pool) => {
				const at = cursor
				cursor += VENUE_READS
				const [permittedHex, receiptHex, liquidityHex, reserveHex] = first.slice(
					at,
					at + VENUE_READS,
				) as [Hex, Hex, Hex, Hex]
				return {
					pool: pool.address,
					kind: pool.kind,
					venuePermitted: decodeFunctionResult({
						abi: accountAbi,
						functionName: 'permittedVenue',
						data: permittedHex,
					}),
					receipt: decodeFunctionResult({
						abi: lendingVenueAbi,
						functionName: 'getReserveAToken',
						data: receiptHex,
					}),
					venueLiquidity: decodeFunctionResult({
						abi: lendingVenueAbi,
						functionName: 'getVirtualUnderlyingBalance',
						data: liquidityHex,
					}),
					supplyRateRay: decodeFunctionResult({
						abi: reserveDataAbi,
						functionName: 'getReserveData',
						data: reserveHex,
					}).currentLiquidityRate,
				}
			}),
		}
	})

	// Keyed by asset **and** pool from here on. The same market appears once per asset it lists, so
	// a map keyed on the pool alone would have every asset reading the first one's receipt.
	const key = (asset: Address, pool: Address) => `${asset.toLowerCase()}:${pool.toLowerCase()}`

	const listed = partial.flatMap((a) =>
		a.venues.filter((v) => v.receipt !== zeroAddress).map((v) => ({ asset: a.asset, ...v })),
	)
	const second = listed.length
		? ethCallBatch(
				runtime,
				rpcUrl,
				listed.flatMap((venue): Call[] => [
					{
						to: venue.receipt,
						data: encodeFunctionData({
							abi: receiptAbi,
							functionName: 'balanceOf',
							args: [account],
						}),
					},
					{
						to: venue.receipt,
						data: encodeFunctionData({
							abi: receiptAbi,
							functionName: 'UNDERLYING_ASSET_ADDRESS',
						}),
					},
				]),
			)
		: []
	const seatOf = new Map(listed.map((venue, seat) => [key(venue.asset, venue.pool), seat]))

	const raw = partial.map((a) => ({
		...a,
		venues: a.venues.map((venue) => {
			const seat = seatOf.get(key(a.asset, venue.pool))
			if (seat === undefined) return { ...venue, receiptBalance: 0n, receiptAsset: zeroAddress }
			const [balanceHex, receiptAssetHex] = second.slice(seat * 2, seat * 2 + 2) as [Hex, Hex]
			return {
				...venue,
				receiptBalance: decodeFunctionResult({
					abi: receiptAbi,
					functionName: 'balanceOf',
					data: balanceHex,
				}),
				receiptAsset: decodeFunctionResult({
					abi: receiptAbi,
					functionName: 'UNDERLYING_ASSET_ADDRESS',
					data: receiptAssetHex,
				}),
			}
		}),
	}))

	// A third batch, and only when something actually needs converting. A rebasing receipt is
	// already denominated in the asset, and a share-priced venue holding nothing has nothing to
	// convert — so the common all-Aave configuration still costs two round trips whatever the
	// number of assets.
	//
	// The receipt is asked rather than the arithmetic repeated here. `previewRedeem` is a handful
	// of lines and copying them would work today; what it would not do is stay equal to the
	// contract that actually burns the shares.
	const needsConverting = raw.flatMap((a) =>
		a.venues
			.filter((v) => v.kind === 'share-priced' && v.receiptBalance > 0n)
			.map((v) => ({ asset: a.asset, ...v })),
	)
	const third = needsConverting.length
		? ethCallBatch(
				runtime,
				rpcUrl,
				needsConverting.map(
					(venue): Call => ({
						to: venue.receipt,
						data: encodeFunctionData({
							abi: sharePricedReceiptAbi,
							functionName: 'previewRedeem',
							args: [venue.receiptBalance],
						}),
					}),
				),
			)
		: []
	const convertedAt = new Map(
		needsConverting.map((venue, seat) => [key(venue.asset, venue.pool), seat]),
	)

	return {
		agent: decodeFunctionResult({ abi: accountAbi, functionName: 'agent', data: agentHex }),
		assets: raw.map((a) => ({
			asset: a.asset,
			idle: a.idle,
			venues: a.venues.map((venue) => {
				const seat = convertedAt.get(key(a.asset, venue.pool))
				if (seat === undefined) return { ...venue, supplied: venue.receiptBalance }
				return {
					...venue,
					supplied: decodeFunctionResult({
						abi: sharePricedReceiptAbi,
						functionName: 'previewRedeem',
						data: third[seat] as Hex,
					}),
				}
			}),
		})),
		nonce: nonceHex ? decodeFunctionResult({ abi: nonceAbi, data: nonceHex }) : undefined,
	}
}
