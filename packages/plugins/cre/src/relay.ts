import { type Address, encodeFunctionData, type Hex } from 'viem'
import { accountAbi, type IdleMoveParams } from './abi'

/**
 * The call to make, so whoever carries it has nothing to encode.
 *
 * This is the whole output of a run that acts: one call, to the account, in the account's own
 * ABI. There is no recipient in it to get wrong — `supplyIdle` credits `address(this)` and
 * `withdrawIdle` returns to `address(this)` — so a relayer that alters this calldata can only
 * change which permitted market the account's own money sits in, and cannot redirect any of it.
 *
 * The deadline in the params is not passed on: neither account function takes one, so it binds
 * the enclave's statement in `sign.ts` and is not something the chain will enforce. Anyone
 * carrying a stale move gets a move that is merely out of date, not one the account refuses.
 */
export function encodeIdleMove(params: IdleMoveParams): { to: Address; data: Hex } {
	return {
		to: params.account,
		data: encodeFunctionData({
			abi: accountAbi,
			functionName: params.supply ? 'supplyIdle' : 'withdrawIdle',
			args: [params.pool, params.asset, params.amount],
		}),
	}
}
