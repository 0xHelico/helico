import type { TeeRuntime } from '@chainlink/cre-sdk'
import { type Hex, slice } from 'viem'
import type { Config } from '../index'

export type EthCallHandler = (data: Hex, to: string) => Hex

type RpcCall = { to: string; data: Hex }
type Batch = { id: number; method: string; params: [RpcCall, string] }[]

export type WriteReportCall = {
	receiver: Uint8Array
	report?: { rawReport?: Uint8Array }
	gasConfig?: { gasLimit?: bigint }
}

/**
 * A TeeRuntime that answers JSON-RPC `eth_call` batches from a table of function selectors,
 * records what leaves the enclave, and fakes the DON's report and write path. Anything not
 * in the table fails loudly, so a test cannot pass on a read it did not model.
 */
export function fakeRuntime(input: {
	config: Config
	secrets: Record<string, string>
	now: number
	handlers: Record<Hex, EthCallHandler>
	writeStatus?: number
	/** Fault injection for the RPC leg: an HTTP status other than 200, or a body that replaces the batch reply. */
	httpStatus?: number
	rpcBody?: string
}) {
	const rpcRequests: Batch[] = []
	const writes: WriteReportCall[] = []
	const reports: string[] = []

	const answer = ({ to, data }: RpcCall): Hex => {
		const handler = input.handlers[slice(data, 0, 4)]
		if (!handler) throw new Error(`unmodelled eth_call ${slice(data, 0, 4)} to ${to}`)
		return handler(data, to)
	}

	const callCapability = ({
		capabilityId,
		method,
		payload,
	}: {
		capabilityId: string
		method: string
		payload: unknown
	}) => {
		if (capabilityId.startsWith('http-actions')) {
			const p = payload as { url: string; body: Uint8Array | string }
			const raw = typeof p.body === 'string' ? Buffer.from(p.body, 'base64') : Buffer.from(p.body)
			const batch = JSON.parse(raw.toString()) as Batch
			rpcRequests.push(batch)
			const replies = batch.map(({ id, params }) => ({
				jsonrpc: '2.0',
				id,
				result: answer(params[0]),
			}))
			return {
				result: () => ({
					statusCode: input.httpStatus ?? 200,
					body: new TextEncoder().encode(input.rpcBody ?? JSON.stringify(replies)),
				}),
			}
		}
		if (capabilityId.startsWith('evm:ChainSelector:') && method === 'WriteReport') {
			writes.push(payload as WriteReportCall)
			return {
				result: () => ({
					txStatus: input.writeStatus ?? 2,
					txHash: new Uint8Array(32).fill(0xab),
					errorMessage: '',
				}),
			}
		}
		throw new Error(`unmodelled capability ${capabilityId}.${method}`)
	}

	const don = {
		callCapability,
		config: input.config,
		now: () => new Date(input.now * 1000),
		log: () => {},
		report: (r: { encodedPayload: string }) => {
			reports.push(r.encodedPayload)
			const rawReport = Buffer.from(r.encodedPayload, 'base64')
			return { result: () => ({ x_generatedCodeOnly_unwrap: () => ({ rawReport }) }) }
		},
	}
	const runtime = {
		...don,
		getSecrets: (requests: { id: string }[]) => ({
			result: () =>
				Object.fromEntries(
					requests.map((r) => [
						r.id,
						{ id: r.id, namespace: 'main', value: input.secrets[r.id] ?? '' },
					]),
				),
		}),
		usingTheDons: () => don,
	}
	return { runtime: runtime as unknown as TeeRuntime<Config>, rpcRequests, writes, reports }
}
