import type { PublicClient } from 'viem'

/** Chain id from the client's configured chain, or from the node when none is configured. */
export async function chainIdOf(client: PublicClient): Promise<number> {
	return client.chain?.id ?? client.getChainId()
}
