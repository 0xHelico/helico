import type { TeeRuntime } from '@chainlink/cre-sdk'
import { type Hex, slice } from 'viem'
import type { Config } from '../index'

export type EthCallHandler = (data: Hex, to: string) => Hex

/** Thrown by a handler to answer the call with a JSON-RPC error, the way a reverting `eth_call` does. */
export class RpcError extends Error {}

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
	/**
	 * What the Aqua subgraph answers, when `config.subgraphUrl` names one. Dispatched by URL
	 * rather than by body, because a GraphQL POST and an `eth_call` batch go through the same
	 * capability and a batch parser handed a GraphQL document fails in a way that looks like the
	 * workflow's bug rather than the fixture's.
	 */
	graphStatus?: number
	graphBody?: string
	/** What the same endpoint answers for the accounts query. */
	graphAccountsBody?: string
	/** Thrown from inside `sendRequest`, the way an unreachable host or an oversized body is. */
	graphThrows?: boolean
}) {
	const rpcRequests: Batch[] = []
	const graphRequests: { query: string; variables: Record<string, unknown> }[] = []
	const writes: WriteReportCall[] = []
	const reports: string[] = []
	const secretRequests: string[] = []

	/**
	 * Two different questions go to one endpoint, so the fake dispatches on the query the way the
	 * endpoint itself would. One body for both would let a test that means to describe balances
	 * silently describe accounts too, and the account list decides which owners get an agent.
	 */
	const graphAnswer = (query: string): string =>
		query.includes('accounts(')
			? (input.graphAccountsBody ?? '{"data":{"accounts":[]}}')
			: (input.graphBody ?? '{"data":{"balances":[]}}')

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
			if (input.config.subgraphUrl && p.url === input.config.subgraphUrl) {
				const sent = JSON.parse(raw.toString()) as { query: string }
				graphRequests.push(sent as never)
				if (input.graphThrows) throw new Error('the subgraph did not answer')
				return {
					result: () => ({
						statusCode: input.graphStatus ?? 200,
						body: new TextEncoder().encode(graphAnswer(sent.query)),
					}),
				}
			}
			const batch = JSON.parse(raw.toString()) as Batch
			rpcRequests.push(batch)
			const replies = batch.map(({ id, params }) => {
				try {
					return { jsonrpc: '2.0', id, result: answer(params[0]) }
				} catch (e) {
					if (e instanceof RpcError) return { jsonrpc: '2.0', id, error: { message: e.message } }
					throw e
				}
			})
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
		getSecrets: (requests: { id: string }[]) => {
			secretRequests.push(...requests.map((r) => r.id))
			return {
				result: () =>
					Object.fromEntries(
						requests.map((r) => [
							r.id,
							{ id: r.id, namespace: 'main', value: input.secrets[r.id] ?? '' },
						]),
					),
			}
		},
		usingTheDons: () => don,
	}
	return {
		runtime: runtime as unknown as TeeRuntime<Config>,
		rpcRequests,
		graphRequests,
		writes,
		reports,
		secretRequests,
	}
}
