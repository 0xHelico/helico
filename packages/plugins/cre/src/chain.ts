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
	/** The ERC-20 being placed. */
	asset: Address
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
export type Pool = { address: Address; kind: ReceiptKind }

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

export type AccountState = {
	/** Who the account will currently accept an idle move from. Zero means nobody. */
	agent: Address
	/** The asset the account holds liquid. */
	idle: bigint
	/** One entry per configured market, in the order the owner wrote them. */
	venues: VenueState[]
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
	{ account, pools, asset }: Addresses,
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

	const first = ethCallBatch(runtime, rpcUrl, [
		{ to: account, data: encodeFunctionData({ abi: accountAbi, functionName: 'agent' }) },
		{
			to: asset,
			data: encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
		},
		...pools.flatMap((pool): Call[] => [
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
		...nonceCall,
	])

	const [agentHex, idleHex] = first as [Hex, Hex]
	const nonceHex = options.withNonce ? first[first.length - 1] : undefined

	// The market's own answers, which is everything except what the receipt knows about itself.
	const partial = pools.map((pool, index) => {
		const at = 2 + index * VENUE_READS
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
	})

	const listed = partial.filter((venue) => venue.receipt !== zeroAddress)
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

	// Which pair of the second batch belongs to which market. The config refuses a repeated pool,
	// so one address names one seat.
	const seatOf = new Map(listed.map((venue, seat) => [venue.pool, seat]))

	// The receipt balances, still in whatever units the receipt counts in.
	const raw = partial.map((venue) => {
		const seat = seatOf.get(venue.pool)
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
	})

	// A third batch, and only when something actually needs converting. A rebasing receipt is
	// already denominated in the asset, and a share-priced venue holding nothing has nothing to
	// convert — so the common single-Aave configuration still costs two round trips, exactly as
	// it did before share-priced venues existed.
	//
	// The receipt is asked rather than the arithmetic repeated here. `previewRedeem` is a handful
	// of lines and copying them would work today; what it would not do is stay equal to the
	// contract that actually burns the shares.
	const needsConverting = raw.filter((v) => v.kind === 'share-priced' && v.receiptBalance > 0n)
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
	const convertedAt = new Map(needsConverting.map((venue, seat) => [venue.pool, seat]))

	return {
		agent: decodeFunctionResult({ abi: accountAbi, functionName: 'agent', data: agentHex }),
		idle: decodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', data: idleHex }),
		venues: raw.map((venue) => {
			const seat = convertedAt.get(venue.pool)
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
		nonce: nonceHex ? decodeFunctionResult({ abi: nonceAbi, data: nonceHex }) : undefined,
	}
}
