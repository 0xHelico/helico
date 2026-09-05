import { AllowanceTransfer } from '@uniswap/permit2-sdk'
import {
	type Address,
	encodeFunctionData,
	maxUint48,
	maxUint160,
	maxUint256,
	type PublicClient,
} from 'viem'
import { erc20Abi } from './abi/erc20'
import { permit2Abi } from './abi/permit2'
import { addresses } from './addresses'
import { chainIdOf } from './client'
import type { Transaction } from './types'

export type Allowances = {
	/** ERC-20 allowance from the owner to Permit2. */
	tokenToPermit2: bigint
	/** Permit2 allowance from the owner to the spender (the Universal Router by default). */
	permit2ToSpender: { amount: bigint; expiration: number; nonce: number }
}

/** Both allowances a Universal Router swap of an ERC-20 input needs. */
export async function getAllowances(
	client: PublicClient,
	{ token, owner, spender }: { token: Address; owner: Address; spender?: Address },
): Promise<Allowances> {
	const chain = addresses(await chainIdOf(client))
	const target = spender ?? chain.universalRouter
	const [tokenToPermit2, [amount, expiration, nonce]] = await Promise.all([
		client.readContract({
			address: token,
			abi: erc20Abi,
			functionName: 'allowance',
			args: [owner, chain.permit2],
		}),
		client.readContract({
			address: chain.permit2,
			abi: permit2Abi,
			functionName: 'allowance',
			args: [owner, token, target],
		}),
	])
	return { tokenToPermit2, permit2ToSpender: { amount, expiration, nonce } }
}

/** Which of the two approvals still has to happen before `amount` can be spent. */
export function approvalsNeeded(
	allowances: Allowances,
	{ amount, nowSeconds = Math.floor(Date.now() / 1000) }: { amount: bigint; nowSeconds?: number },
): { token: boolean; permit2: boolean } {
	const { amount: allowed, expiration } = allowances.permit2ToSpender
	return {
		token: allowances.tokenToPermit2 < amount,
		permit2: allowed < amount || expiration <= nowSeconds,
	}
}

/** ERC-20 `approve(Permit2, amount)`. Unlimited by default, as Uniswap's own flow does. */
export function encodeApproveTokenToPermit2({
	chainId,
	token,
	amount = maxUint256,
}: {
	chainId: number
	token: Address
	amount?: bigint
}): Transaction {
	return {
		to: token,
		data: encodeFunctionData({
			abi: erc20Abi,
			functionName: 'approve',
			args: [addresses(chainId).permit2, amount],
		}),
		value: 0n,
	}
}

export type Permit2ApprovalInput = {
	chainId: number
	token: Address
	spender?: Address
	/** uint160; unlimited by default. */
	amount?: bigint
	/** uint48 unix seconds; never expires by default. */
	expiration?: number
}

/** Permit2 `approve(token, spender, amount, expiration)` as an on-chain transaction. */
export function encodeApprovePermit2({
	chainId,
	token,
	spender,
	amount = maxUint160,
	expiration = Number(maxUint48),
}: Permit2ApprovalInput): Transaction {
	const chain = addresses(chainId)
	return {
		to: chain.permit2,
		data: encodeFunctionData({
			abi: permit2Abi,
			functionName: 'approve',
			args: [token, spender ?? chain.universalRouter, amount, expiration],
		}),
		value: 0n,
	}
}

export type PermitSingleInput = Permit2ApprovalInput & {
	/** Current nonce from `getAllowances().permit2ToSpender.nonce`. */
	nonce: number
	/** Unix seconds until which the signature is valid. */
	sigDeadline: bigint
}

export type PermitSingleTypedData = {
	domain: { name: string; chainId: number; verifyingContract: Address }
	types: Record<string, { name: string; type: string }[]>
	primaryType: 'PermitSingle'
	message: {
		details: { token: Address; amount: bigint; expiration: number; nonce: number }
		spender: Address
		sigDeadline: bigint
	}
}

/**
 * EIP-712 data for a Permit2 `PermitSingle`, shaped for viem's `signTypedData`.
 * Signing it replaces the on-chain Permit2 approval; the router consumes it with PERMIT2_PERMIT.
 */
export function permitSingleTypedData({
	chainId,
	token,
	spender,
	amount = maxUint160,
	expiration = Number(maxUint48),
	nonce,
	sigDeadline,
}: PermitSingleInput): PermitSingleTypedData {
	const chain = addresses(chainId)
	const target = spender ?? chain.universalRouter
	const { domain, types } = AllowanceTransfer.getPermitData(
		{
			details: { token, amount: amount.toString(), expiration, nonce },
			spender: target,
			sigDeadline: sigDeadline.toString(),
		},
		chain.permit2,
		chainId,
	)
	return {
		domain: { name: String(domain.name), chainId, verifyingContract: chain.permit2 },
		types: types as PermitSingleTypedData['types'],
		primaryType: 'PermitSingle',
		message: { details: { token, amount, expiration, nonce }, spender: target, sigDeadline },
	}
}
