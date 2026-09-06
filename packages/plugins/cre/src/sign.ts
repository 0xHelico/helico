import {
	type Address,
	encodeAbiParameters,
	type Hex,
	hashTypedData,
	recoverTypedDataAddress,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { type RecenterParams, recenterParamsAbi } from './abi'

/**
 * The EIP-712 authorisation the enclave signs on the vault's behalf. The vault's own struct is
 * nested so Solidity hashes it with one `hashStruct` and the field order stays the contract's;
 * the mandate hash binds the decision to the mandate the vault holds, the nonce makes it single
 * use.
 */
export const RECENTER_TYPES = {
	RecenterParams: [
		{ name: 'owner', type: 'address' },
		{ name: 'tickLower', type: 'int24' },
		{ name: 'tickUpper', type: 'int24' },
		{ name: 'liquidityToMint', type: 'uint256' },
		{ name: 'amount0Min', type: 'uint128' },
		{ name: 'amount1Min', type: 'uint128' },
		{ name: 'amount0Max', type: 'uint128' },
		{ name: 'amount1Max', type: 'uint128' },
		{ name: 'zeroForOne', type: 'bool' },
		{ name: 'amountIn', type: 'uint256' },
		{ name: 'minAmountOut', type: 'uint256' },
		{ name: 'deadline', type: 'uint256' },
	],
	Recenter: [
		{ name: 'params', type: 'RecenterParams' },
		{ name: 'mandateHash', type: 'bytes32' },
		{ name: 'nonce', type: 'uint256' },
	],
} as const

export type RecentreDomain = {
	name: string
	version: string
	chainId: number
	verifyingContract: Address
}

export type Authorisation = {
	params: RecenterParams
	mandateHash: Hex
	nonce: bigint
}

export const recentreTypedData = (domain: RecentreDomain, auth: Authorisation) =>
	({
		domain,
		types: RECENTER_TYPES,
		primaryType: 'Recenter',
		message: { params: auth.params, mandateHash: auth.mandateHash, nonce: auth.nonce },
	}) as const

/** The digest the vault must recompute: `_hashTypedDataV4(keccak256(abi.encode(TYPEHASH, hashStruct(params), mandateHash, nonce)))`. */
export const recentreDigest = (domain: RecentreDomain, auth: Authorisation): Hex =>
	hashTypedData(recentreTypedData(domain, auth))

/** Signs with the agent key. Deterministic (RFC 6979), so every enclave that runs this agrees. */
export async function signRecentre(
	privateKey: Hex,
	domain: RecentreDomain,
	auth: Authorisation,
): Promise<{ signature: Hex; signer: Address }> {
	const account = privateKeyToAccount(privateKey)
	return {
		signature: await account.signTypedData(recentreTypedData(domain, auth)),
		signer: account.address,
	}
}

export const recoverRecentreSigner = (
	domain: RecentreDomain,
	auth: Authorisation,
	signature: Hex,
): Promise<Address> => recoverTypedDataAddress({ ...recentreTypedData(domain, auth), signature })

const AUTHORISATION_ABI = [
	recenterParamsAbi,
	{ type: 'bytes32' },
	{ type: 'uint256' },
	{ type: 'bytes' },
] as const

/** What crosses out of the enclave: `abi.encode(RecenterParams, bytes32 mandateHash, uint256 nonce, bytes signature)`. */
export const encodeAuthorisation = (auth: Authorisation, signature: Hex): Hex =>
	encodeAbiParameters(AUTHORISATION_ABI, [auth.params, auth.mandateHash, auth.nonce, signature])
