import { bytesToBase64, cre, ok, type TeeRuntime, text } from '@chainlink/cre-sdk'
import {
	type Address,
	decodeFunctionResult,
	encodeFunctionData,
	getAddress,
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
	/** The lending market. Must be one the owner allowlisted, which is read below, not assumed. */
	pool: Address
	/** The ERC-20 being placed. */
	asset: Address
}

export type AccountState = {
	/** Who the account will currently accept an idle move from. Zero means nobody. */
	agent: Address
	/** Whether the owner still allows this market. */
	venuePermitted: boolean
	/** The asset the account holds liquid. */
	idle: bigint
	/** The receipt the market issues for this asset, asked of the market rather than the receipt. */
	receipt: Address
	/** What that receipt says it is for. Zero when the market does not list the asset. */
	receiptAsset: Address
	/** The account's position at the market, in the asset's units. */
	supplied: bigint
	/** What the market can pay out right now. */
	venueLiquidity: bigint
	/** Aave's `currentLiquidityRate`, a ray. */
	supplyRateRay: bigint
	/** The account's signature nonce, read only when the enclave signs. */
	nonce?: bigint
}

/**
 * Everything the decision needs, in two batches.
 *
 * There are two and not one because of a rule the contracts state plainly: the market is asked
 * which receipt it issues, never the receipt asked which market it belongs to. A forged receipt
 * returns the real pool's address and passes the second check while failing the first, so the
 * receipt's address has to come out of the first batch before its balance can be read in the
 * second. When the market does not list the asset at all there is no receipt and no second
 * batch; the caller holds on that.
 */
export function readAccountState(
	runtime: TeeRuntime<unknown>,
	rpcUrl: string,
	{ account, pool, asset }: Addresses,
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
	const [agentHex, permittedHex, idleHex, receiptHex, liquidityHex, reserveHex, nonceHex] =
		ethCallBatch(runtime, rpcUrl, [
			{ to: account, data: encodeFunctionData({ abi: accountAbi, functionName: 'agent' }) },
			{
				to: account,
				data: encodeFunctionData({
					abi: accountAbi,
					functionName: 'permittedVenue',
					args: [pool],
				}),
			},
			{
				to: asset,
				data: encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
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
			...nonceCall,
		]) as [Hex, Hex, Hex, Hex, Hex, Hex, Hex | undefined]

	const receipt = decodeFunctionResult({
		abi: lendingVenueAbi,
		functionName: 'getReserveAToken',
		data: receiptHex,
	})
	const reserve = decodeFunctionResult({
		abi: reserveDataAbi,
		functionName: 'getReserveData',
		data: reserveHex,
	})

	const listed = getAddress(receipt) !== zeroAddress
	const [suppliedHex, receiptAssetHex] = listed
		? (ethCallBatch(runtime, rpcUrl, [
				{
					to: receipt,
					data: encodeFunctionData({
						abi: receiptAbi,
						functionName: 'balanceOf',
						args: [account],
					}),
				},
				{
					to: receipt,
					data: encodeFunctionData({
						abi: receiptAbi,
						functionName: 'UNDERLYING_ASSET_ADDRESS',
					}),
				},
			]) as [Hex, Hex])
		: [undefined, undefined]

	return {
		agent: decodeFunctionResult({ abi: accountAbi, functionName: 'agent', data: agentHex }),
		venuePermitted: decodeFunctionResult({
			abi: accountAbi,
			functionName: 'permittedVenue',
			data: permittedHex,
		}),
		idle: decodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', data: idleHex }),
		receipt,
		receiptAsset: receiptAssetHex
			? decodeFunctionResult({
					abi: receiptAbi,
					functionName: 'UNDERLYING_ASSET_ADDRESS',
					data: receiptAssetHex,
				})
			: zeroAddress,
		supplied: suppliedHex
			? decodeFunctionResult({ abi: receiptAbi, functionName: 'balanceOf', data: suppliedHex })
			: 0n,
		venueLiquidity: decodeFunctionResult({
			abi: lendingVenueAbi,
			functionName: 'getVirtualUnderlyingBalance',
			data: liquidityHex,
		}),
		supplyRateRay: reserve.currentLiquidityRate,
		nonce: nonceHex ? decodeFunctionResult({ abi: nonceAbi, data: nonceHex }) : undefined,
	}
}
