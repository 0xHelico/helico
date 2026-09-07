import { AQUA_CONTRACT_ADDRESSES } from '@1inch/aqua-sdk'
import { AQUA_SWAP_VM_CONTRACT_ADDRESSES } from '@1inch/swap-vm-sdk'

/**
 * The two contracts an Aqua position needs, read out of 1inch's own SDKs rather than written
 * down here.
 *
 * This is not fussiness. Until #165 this repository targeted `0x499943E7…`, found by scanning
 * `eth_getLogs` forward for a contract emitting Aqua's events. It found one: a real Aqua, with
 * real events, that has emitted nothing since block 451,737,844. Scanning for a contract that
 * behaves like Aqua finds a contract that behaves like Aqua — it cannot tell you whether anyone
 * still uses it.
 *
 * Two things settle it, and both are here: the vendor's constant, and the fact that the deployed
 * `AquaSwapVMRouter` carries the same address in its bytecode. `assertRouterKnowsAqua` in the
 * live check is the second half.
 */
export function aquaAddress(chainId: number): `0x${string}` {
	const a = (AQUA_CONTRACT_ADDRESSES as Record<number, { toString(): string }>)[chainId]
	if (!a) throw new Error(`No Aqua deployment for chain ${chainId}`)
	return a.toString().toLowerCase() as `0x${string}`
}

/**
 * The SwapVM router, which is the *app* a concentrated position is shipped to.
 *
 * Worth being clear about, because it is the trade-off in the 1inch track: ship here and the
 * pricing is 1inch's audited `concentrate`, and the Aqua app is theirs. Ship to
 * `HelicoMandateSwap` instead and the app is ours and the curve is ours to write.
 */
export function swapVmAddress(chainId: number): `0x${string}` {
	const a = (AQUA_SWAP_VM_CONTRACT_ADDRESSES as Record<number, { toString(): string }>)[chainId]
	if (!a) throw new Error(`No SwapVM router for chain ${chainId}`)
	return a.toString().toLowerCase() as `0x${string}`
}

/** Chains this package has been exercised on. Arbitrum One is the one with tests behind it. */
export const ARBITRUM_ONE = 42161
export const BASE = 8453
