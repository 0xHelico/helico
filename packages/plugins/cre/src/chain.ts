import { bytesToBase64, cre, ok, type TeeRuntime, text } from '@chainlink/cre-sdk'
import {
	type Address,
	decodeFunctionResult,
	encodeFunctionData,
	type Hex,
	parseAbi,
	zeroAddress,
} from 'viem'
import { accountAbi, erc20Abi, lendingVenueAbi, receiptAbi, reserveDataAbi } from './abi'

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
	pools: Address[]
	/** The ERC-20 being placed. */
	asset: Address
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
	/** The account's position at this market, in the asset's units. */
	supplied: bigint
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
					args: [pool],
				}),
			},
			{
				to: pool,
				data: encodeFunctionData({
					abi: lendingVenueAbi,
					functionName: 'getReserveAToken',
					args: [asset],
				}),
			},
			{
				to: pool,
				data: encodeFunctionData({
					abi: lendingVenueAbi,
					functionName: 'getVirtualUnderlyingBalance',
					args: [asset],
				}),
			},
			{
				to: pool,
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
			pool,
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

	return {
		agent: decodeFunctionResult({ abi: accountAbi, functionName: 'agent', data: agentHex }),
		idle: decodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', data: idleHex }),
		venues: partial.map((venue) => {
			const seat = seatOf.get(venue.pool)
			if (seat === undefined) return { ...venue, supplied: 0n, receiptAsset: zeroAddress }
			const [suppliedHex, receiptAssetHex] = second.slice(seat * 2, seat * 2 + 2) as [Hex, Hex]
			return {
				...venue,
				supplied: decodeFunctionResult({
					abi: receiptAbi,
					functionName: 'balanceOf',
					data: suppliedHex,
				}),
				receiptAsset: decodeFunctionResult({
					abi: receiptAbi,
					functionName: 'UNDERLYING_ASSET_ADDRESS',
					data: receiptAssetHex,
				}),
			}
		}),
		nonce: nonceHex ? decodeFunctionResult({ abi: nonceAbi, data: nonceHex }) : undefined,
	}
}
