import type { Chain, Client, Transport } from 'viem'
import { getChainId } from 'viem/actions'

/**
 * Any viem client, including chain-typed ones such as `createPublicClient({ chain: base })`.
 * The package calls viem's tree-shakable actions on it, which is how viem recommends libraries
 * accept clients: a `PublicClient` parameter rejects clients whose chain has custom formatters.
 */
export type ChainClient = Client<Transport, Chain | undefined>

/** Chain id from the client's configured chain, or from the node when none is configured. */
export async function chainIdOf(client: ChainClient): Promise<number> {
	return client.chain?.id ?? getChainId(client)
}
