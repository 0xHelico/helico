import { encodeAbiParameters, encodeFunctionData, parseAbi } from 'viem'

import { aquaAddress } from './addresses'
import { AQUA_ABI, type Call, strategyHash } from './calldata'

/**
 * A mandate, as `HelicoMandateSwap` reads it.
 *
 * Aqua files a position under `keccak256` of the **raw bytes** the maker shipped, so these bytes
 * are the mandate's identity rather than a serialisation of it. Encode one field in the wrong
 * order or the wrong width and nothing reverts: the ship succeeds, the hash differs from the one
 * the app computes, and every later call answers for a mandate nobody shipped. The contract says
 * so itself on `mandateHash` — *"ship anything else and the mandate is unreachable"* — which is
 * why `check-mandate.ts` compares these bytes against the deployed contract's own answer instead
 * of trusting the tuple below to be right.
 */

/**
 * Whether one receipt unit is one underlying unit.
 *
 * `Rebasing` for an Aave aToken, which is every venue this has pointed at so far. `SharePriced`
 * for an ERC-4626 share or a cToken, where the unit price moves.
 */
export const ReceiptKind = { Rebasing: 0, SharePriced: 1 } as const
export type ReceiptKind = (typeof ReceiptKind)[keyof typeof ReceiptKind]

/** A lending market the mandate's capital may sit in between fills, and its two receipts. */
export type Venue = {
	pool: `0x${string}`
	receipt0: `0x${string}`
	receipt1: `0x${string}`
	kind: ReceiptKind
}

export type SwapMandate = {
	/** Whose tokens these are. Aqua keys balances by the shipping address; the app reads this one,
	 *  so they have to be the same address or the mandate spends a wallet it cannot reach. */
	maker: `0x${string}`
	token0: `0x${string}`
	token1: `0x${string}`
	/** Swap fee in basis points, kept by the maker. Below 10000. */
	feeBps: bigint
	/** Per-swap ceiling on how much `token0` may leave, in `token0`'s own units. */
	maxOut0: bigint
	/** The same for `token1`. One scalar cannot mean anything across a pair. */
	maxOut1: bigint
	/** First timestamp at which the mandate is dead. Zero means dead now, not "no expiry". */
	expiry: bigint
	/** The only contract allowed to call a swap, or the zero address for anyone. Never an EOA:
	 *  the fill arrives as a callback, so a taker has to be a contract. */
	agent: `0x${string}`
	/** Distinguishes two otherwise identical mandates. Aqua refuses a hash it has ever seen. */
	salt: `0x${string}`
	/** Empty behaves exactly as the mandate did before venues existed. */
	venues: Venue[]
}

/** The tuple `abi.encode(SwapMandate)` produces. Field order is the struct's, and it is load-bearing. */
const MANDATE_TUPLE = {
	type: 'tuple',
	components: [
		{ name: 'maker', type: 'address' },
		{ name: 'token0', type: 'address' },
		{ name: 'token1', type: 'address' },
		{ name: 'feeBps', type: 'uint256' },
		{ name: 'maxOut0', type: 'uint256' },
		{ name: 'maxOut1', type: 'uint256' },
		{ name: 'expiry', type: 'uint64' },
		{ name: 'agent', type: 'address' },
		{ name: 'salt', type: 'bytes32' },
		{
			name: 'venues',
			type: 'tuple[]',
			components: [
				{ name: 'pool', type: 'address' },
				{ name: 'receipt0', type: 'address' },
				{ name: 'receipt1', type: 'address' },
				{ name: 'kind', type: 'uint8' },
			],
		},
	],
} as const

/** The ABI the app exposes for reading a mandate back. `mandateHash` is `pure`, so an
 *  `eth_call` against the deployed contract needs no fork, no key and no funds. */
export const MANDATE_SWAP_ABI = [
	{
		type: 'function',
		name: 'mandateHash',
		stateMutability: 'pure',
		inputs: [{ ...MANDATE_TUPLE, name: 'mandate' }],
		outputs: [{ type: 'bytes32' }],
	},
	{
		type: 'function',
		name: 'quoteExactIn',
		stateMutability: 'view',
		inputs: [
			{ ...MANDATE_TUPLE, name: 'mandate' },
			{ name: 'zeroForOne', type: 'bool' },
			{ name: 'amountIn', type: 'uint256' },
		],
		outputs: [{ type: 'uint256' }],
	},
] as const

/**
 * The bytes to ship. `abi.encode(mandate)` and nothing else.
 *
 * Through viem's encoder rather than hand-packed: `venues` makes the struct dynamic, so the
 * encoding carries a head offset that is easy to get wrong by hand and invisible when you do.
 */
export function encodeMandate(mandate: SwapMandate): `0x${string}` {
	return encodeAbiParameters([MANDATE_TUPLE], [mandate])
}

/** Aqua's identifier for this mandate: the hash of the bytes above, which is what `ship` files it
 *  under and what `safeBalances` needs to find it again. */
export function mandateHash(mandate: SwapMandate): `0x${string}` {
	return strategyHash(encodeMandate(mandate))
}

const ERC20_APPROVE_ABI = parseAbi(['function approve(address spender, uint256 value)'])

/**
 * Everything the maker's account has to run, once, to open a mandate.
 *
 * Three approvals and a ship, in that order, which is the shape `AccountIsTheMaker.t.sol` proves
 * in a single signature. The approvals are to **Aqua**, never to a Helico contract: Aqua's `pull`
 * does `safeTransferFrom(maker, to, amount)` at fill time, so the allowance has to exist and it
 * has to point there. An allowance to this project's own contracts would be custody, would
 * outlive the mandate, and would survive `dock`.
 *
 * The receipt tokens are approved alongside the pair on purpose. That is what lets a fill be paid
 * out of the maker's Aave position rather than only out of idle tokens, and it is the reason
 * `tokens` here is the shipped list rather than just the pair.
 *
 * `ship` moves nothing. It writes a ledger entry, so `amounts` is a claim about what may be spent
 * and not a deposit — the wallet is checked at fill time, not here.
 */
export function mandateSetupCalls(
	chainId: number,
	app: `0x${string}`,
	mandate: SwapMandate,
	tokens: `0x${string}`[],
	amounts: bigint[],
): Call[] {
	if (tokens.length !== amounts.length)
		throw new Error('tokens and amounts must be the same length')
	if (tokens.length === 0) throw new Error('a mandate with no tokens can never be filled')

	const aqua = aquaAddress(chainId)
	const approvals = tokens.map((token, i) => ({
		to: token,
		data: encodeFunctionData({
			abi: ERC20_APPROVE_ABI,
			functionName: 'approve',
			// Exactly what was shipped, not an unlimited allowance. Aqua can only spend what the
			// ledger says anyway, so a larger approval buys nothing and outlives the mandate.
			args: [aqua, amounts[i] as bigint],
		}),
	}))

	return [
		...approvals,
		{
			to: aqua,
			data: encodeFunctionData({
				abi: AQUA_ABI,
				functionName: 'ship',
				args: [app, encodeMandate(mandate), tokens, amounts],
			}),
		},
	]
}
