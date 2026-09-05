import {
	type Abi,
	type Address,
	decodeFunctionData,
	encodeFunctionResult,
	type Hex,
	toHex,
} from 'viem'
import type { ChainClient } from '../client'

export type FakeContract = { address: Address; abi: Abi; results: Record<string, unknown> }
export type RecordedCall = {
	to: Address
	functionName: string
	args: readonly unknown[]
	value?: bigint
}

/**
 * A viem client whose `request` answers `eth_call` from the real ABIs, so reads and quotes in
 * tests go through the same encoding and decoding as production.
 */
export function fakeClient(chainId: number, contracts: FakeContract[]) {
	const calls: RecordedCall[] = []
	const request = async ({ method, params }: { method: string; params?: unknown }) => {
		if (method === 'eth_chainId') return toHex(chainId)
		if (method !== 'eth_call') throw new Error(`fake client: unexpected ${method}`)
		const [{ to, data, value }] = params as [{ to: Address; data: Hex; value?: Hex }]
		const contract = contracts.find((c) => c.address.toLowerCase() === to.toLowerCase())
		if (!contract) throw new Error(`fake client: no contract at ${to}`)
		const { functionName, args } = decodeFunctionData({ abi: contract.abi, data })
		calls.push({ to, functionName, args: args ?? [], value: value ? BigInt(value) : undefined })
		if (!(functionName in contract.results))
			throw new Error(`fake client: no result for ${functionName}`)
		return encodeFunctionResult({
			abi: contract.abi,
			functionName,
			result: contract.results[functionName],
		})
	}
	return { client: { chain: { id: chainId }, request } as unknown as ChainClient, calls }
}
