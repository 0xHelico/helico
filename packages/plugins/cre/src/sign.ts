import {
	type Address,
	encodeAbiParameters,
	type Hex,
	hashTypedData,
	recoverTypedDataAddress,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { type IdleMoveParams, idleMoveParamsAbi } from './abi'

/**
 * The EIP-712 statement the enclave signs over the move it decided on. The params are nested as
 * their own struct so Solidity hashes them with one `hashStruct` and the field order stays the
 * one `idleMoveParamsAbi` declares; the policy hash binds the move to the thresholds it came
 * from, and the account's nonce makes a given statement single use.
 *
 * **No contract verifies this typehash today, and saying otherwise would be the dishonest kind
 * of claim.** `HelicoAccount` accepts an idle move from its agent by `msg.sender` and nothing
 * else; its one signature path, `executeWithSignature`, verifies the *owner's* `Execute` digest,
 * which this is not and must not become — a contract that accepted an agent's signature there
 * would hand the agent everything `execute` can do, which is the opposite of the design.
 *
 * What the signature is for, then: it is the enclave attesting that this exact move is what it
 * decided, verifiable by anyone holding the agent's address, and it is what a relayer carries
 * alongside the calldata from `relay.ts`. The move itself still executes as a call from the
 * agent.
 */
export const IDLE_MOVE_TYPES = {
	IdleMoveParams: [
		{ name: 'account', type: 'address' },
		{ name: 'pool', type: 'address' },
		{ name: 'asset', type: 'address' },
		{ name: 'amount', type: 'uint256' },
		{ name: 'supply', type: 'bool' },
		{ name: 'deadline', type: 'uint256' },
	],
	IdleMove: [
		{ name: 'params', type: 'IdleMoveParams' },
		{ name: 'policyHash', type: 'bytes32' },
		{ name: 'nonce', type: 'uint256' },
	],
} as const

/**
 * The account's own domain, field for field as `AccountAuth.domainSeparator` builds it: name
 * `HelicoAccount`, version `1`, the chain id, and the account as the verifying contract. Binding
 * it to one account is what stops a statement about one being replayed against another the same
 * owner holds.
 */
export type IdleMoveDomain = {
	name: string
	version: string
	chainId: number
	verifyingContract: Address
}

export type Authorisation = {
	params: IdleMoveParams
	policyHash: Hex
	nonce: bigint
}

export const idleMoveTypedData = (domain: IdleMoveDomain, auth: Authorisation) =>
	({
		domain,
		types: IDLE_MOVE_TYPES,
		primaryType: 'IdleMove',
		message: { params: auth.params, policyHash: auth.policyHash, nonce: auth.nonce },
	}) as const

/** `_hashTypedDataV4(keccak256(abi.encode(TYPEHASH, hashStruct(params), policyHash, nonce)))`. */
export const idleMoveDigest = (domain: IdleMoveDomain, auth: Authorisation): Hex =>
	hashTypedData(idleMoveTypedData(domain, auth))

/** Signs with the agent key. Deterministic (RFC 6979), so every enclave that runs this agrees. */
export async function signIdleMove(
	privateKey: Hex,
	domain: IdleMoveDomain,
	auth: Authorisation,
): Promise<{ signature: Hex; signer: Address }> {
	const account = privateKeyToAccount(privateKey)
	return {
		signature: await account.signTypedData(idleMoveTypedData(domain, auth)),
		signer: account.address,
	}
}

export const recoverIdleMoveSigner = (
	domain: IdleMoveDomain,
	auth: Authorisation,
	signature: Hex,
): Promise<Address> => recoverTypedDataAddress({ ...idleMoveTypedData(domain, auth), signature })

const AUTHORISATION_ABI = [
	idleMoveParamsAbi,
	{ type: 'bytes32' },
	{ type: 'uint256' },
	{ type: 'bytes' },
] as const

/** What crosses out of the enclave: `abi.encode(IdleMoveParams, bytes32 policyHash, uint256 nonce, bytes signature)`. */
export const encodeAuthorisation = (auth: Authorisation, signature: Hex): Hex =>
	encodeAbiParameters(AUTHORISATION_ABI, [auth.params, auth.policyHash, auth.nonce, signature])
