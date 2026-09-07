import type { Address, Hex } from 'viem'

/** Identifies a v4 pool. `currency0 < currency1`; native ETH is the zero address. */
export type PoolKey = {
	currency0: Address
	currency1: Address
	fee: number
	tickSpacing: number
	hooks: Address
}

/** One hop of a multi-hop route, in the shape the router and the Quoter read. */
export type PathKey = {
	intermediateCurrency: Address
	fee: number
	tickSpacing: number
	hooks: Address
	hookData: Hex
}

/** Pool parameters without the currencies, used to describe a hop. */
export type PoolParams = {
	fee: number
	tickSpacing: number
	hooks?: Address
	hookData?: Hex
}

/** Everything needed to send a transaction. Nothing here is signed. */
export type Transaction = {
	to: Address
	data: Hex
	value: bigint
}
