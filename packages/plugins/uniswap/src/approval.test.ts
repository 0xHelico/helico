import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, maxUint48, maxUint160, maxUint256, type PublicClient } from 'viem'
import { erc20Abi } from './abi/erc20'
import { permit2Abi } from './abi/permit2'
import { addresses } from './addresses'
import {
	type Allowances,
	approvalsNeeded,
	encodeApprovePermit2,
	encodeApproveTokenToPermit2,
	getAllowances,
	permitSingleTypedData,
} from './approval'

const BASE = 8453
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const OWNER = '0x4200000000000000000000000000000000000006'
const chain = addresses(BASE)

describe('getAllowances', () => {
	test('reads the token allowance to Permit2 and the Permit2 allowance to the router', async () => {
		const calls: { address: string; functionName: string; args: unknown[] }[] = []
		const client = {
			chain: { id: BASE },
			readContract: async (c: { address: string; functionName: string; args: unknown[] }) => {
				calls.push(c)
				return c.address === USDC ? 7n : [5n, 1_800_000_000, 3]
			},
		} as unknown as PublicClient

		const allowances = await getAllowances(client, { token: USDC, owner: OWNER })

		expect(allowances).toEqual({
			tokenToPermit2: 7n,
			permit2ToSpender: { amount: 5n, expiration: 1_800_000_000, nonce: 3 },
		})
		expect(calls.find((c) => c.address === USDC)?.args).toEqual([OWNER, chain.permit2])
		expect(calls.find((c) => c.address === chain.permit2)?.args).toEqual([
			OWNER,
			USDC,
			chain.universalRouter,
		])
	})
})

describe('approvalsNeeded', () => {
	const enough: Allowances = {
		tokenToPermit2: 100n,
		permit2ToSpender: { amount: 100n, expiration: 2_000_000_000, nonce: 0 },
	}

	test('nothing to do when both allowances cover the amount', () => {
		expect(approvalsNeeded(enough, { amount: 100n, nowSeconds: 1_900_000_000 })).toEqual({
			token: false,
			permit2: false,
		})
	})

	test('flags a short token allowance', () => {
		expect(
			approvalsNeeded({ ...enough, tokenToPermit2: 99n }, { amount: 100n, nowSeconds: 1 }).token,
		).toBe(true)
	})

	test('flags an expired or short Permit2 allowance', () => {
		expect(approvalsNeeded(enough, { amount: 100n, nowSeconds: 2_000_000_000 }).permit2).toBe(true)
		expect(
			approvalsNeeded(
				{ ...enough, permit2ToSpender: { ...enough.permit2ToSpender, amount: 1n } },
				{ amount: 100n, nowSeconds: 1 },
			).permit2,
		).toBe(true)
	})
})

describe('approval calldata', () => {
	test('token approve targets Permit2 with an unlimited amount by default', () => {
		const tx = encodeApproveTokenToPermit2({ chainId: BASE, token: USDC })
		const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data: tx.data })
		expect(tx.to).toBe(USDC)
		expect(tx.value).toBe(0n)
		expect(functionName).toBe('approve')
		expect(args).toEqual([chain.permit2, maxUint256])
	})

	test('Permit2 approve targets the router, unlimited and never expiring by default', () => {
		const tx = encodeApprovePermit2({ chainId: BASE, token: USDC })
		const { functionName, args } = decodeFunctionData({ abi: permit2Abi, data: tx.data })
		expect(tx.to).toBe(chain.permit2)
		expect(functionName).toBe('approve')
		expect(args).toEqual([USDC, chain.universalRouter, maxUint160, Number(maxUint48)])
	})
})

describe('permitSingleTypedData', () => {
	test('is shaped for signTypedData with the Permit2 domain', () => {
		const data = permitSingleTypedData({
			chainId: BASE,
			token: USDC,
			nonce: 3,
			sigDeadline: 1_700_000_000n,
			amount: 10n,
			expiration: 1_800_000_000,
		})
		expect(data.domain).toEqual({
			name: 'Permit2',
			chainId: BASE,
			verifyingContract: chain.permit2,
		})
		expect(data.primaryType).toBe('PermitSingle')
		expect(Object.keys(data.types).sort()).toEqual(['PermitDetails', 'PermitSingle'])
		expect(data.message).toEqual({
			details: { token: USDC, amount: 10n, expiration: 1_800_000_000, nonce: 3 },
			spender: chain.universalRouter,
			sigDeadline: 1_700_000_000n,
		})
	})
})
