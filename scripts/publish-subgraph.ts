#!/usr/bin/env bun
/**
 * Publish Helico's subgraph to The Graph Network, from a key rather than from a browser.
 *
 * `graph publish` builds, pins, and then opens `cli.thegraph.com/publish` for a wallet to sign
 * the transaction. The transaction it wants signed is one call on the L2GNS contract on Arbitrum
 * One, and everything before it — the deployment already on The Graph's IPFS from `graph deploy`,
 * two small metadata files pinned beside it — is public and needs no account. So this does the
 * same thing from the deployer key, and stops.
 *
 *     PUBLISHER_KEY=0x… CONFIRM=publish bun scripts/publish-subgraph.ts
 *
 * What it does, in order, and each step is checked before the next:
 *
 *   1. Refuses off Arbitrum One, without `CONFIRM=publish`, and on a deployment the Studio
 *      endpoint does not currently serve — the id below has to be the one `version/latest`
 *      answers `_meta.deployment` with, or the network would index something Studio is not.
 *   2. Reads the manifest back from The Graph's IPFS node by that hash. A deployment the node
 *      cannot serve is one no indexer can fetch.
 *   3. Pins the subgraph metadata and the version metadata — the keys are the ones
 *      `graph-network-subgraph/src/mappings/ipfs.ts` reads: `displayName`, `description`,
 *      `codeRepository`, `website`, `categories`, `image` for the subgraph; `label`,
 *      `description` for the version.
 *   4. Calls `L2GNS.publishNewSubgraph(deploymentID, versionMetadata, subgraphMetadata)`, each a
 *      bytes32 that is the IPFS multihash with its two-byte `0x1220` prefix removed.
 *   5. Reads `SubgraphPublished` out of the receipt and prints the subgraph id as The Graph
 *      shows it — base58 of the 32-byte id — which is what `BE_GRAPH_MCP_SUBGRAPH_ID` wants.
 *
 * Why this is safe to run from the deployer: the call transfers nothing but gas, mints the
 * subgraph's NFT to the sender, and changes nothing about any Helico contract. The NFT is what
 * publishes later versions, so the deployer is the key that upgrades the network deployment —
 * the same key that deploys everything else.
 *
 * Addresses come from The Graph's contracts page and were confirmed on chain before this was
 * written: `0xec9A7fb6…` answers `subgraphNFT()` with `0x3FbD54f0…`, which is what the page lists.
 */
import bs58 from 'bs58'
import {
	createPublicClient,
	createWalletClient,
	decodeEventLog,
	formatEther,
	type Hex,
	http,
	parseAbi,
	toHex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrum } from 'viem/chains'

const ARBITRUM_ONE = 42161
const RPC = process.env.RPC_URL ?? 'https://arb1.arbitrum.io/rpc'
const IPFS = 'https://api.thegraph.com/ipfs/api/v0'
const STUDIO = 'https://api.studio.thegraph.com/query/1758877/helico-arbitrum-one/version/latest'

/** L2GNS on Arbitrum One, behind `GraphProxy`. The Graph's contracts page; `subgraphNFT()` confirmed. */
const L2GNS = '0xec9A7fb6CbC2E41926127929c2dcE6e9c5D33Bec' as const
const SUBGRAPH_NFT = '0x3FbD54f0cc17b7aE649008dEEA12ed7D2622B23f' as const

const gnsAbi = parseAbi([
	'function publishNewSubgraph(bytes32 _subgraphDeploymentID, bytes32 _versionMetadata, bytes32 _subgraphMetadata)',
	'function subgraphNFT() view returns (address)',
	'function isPublished(uint256 _subgraphID) view returns (bool)',
	'event SubgraphPublished(uint256 indexed subgraphID, bytes32 indexed subgraphDeploymentID, uint32 reserveRatio)',
	'event SubgraphVersionUpdated(uint256 indexed subgraphID, bytes32 indexed subgraphDeploymentID, bytes32 versionMetadata)',
	'event SubgraphMetadataUpdated(uint256 indexed subgraphID, bytes32 subgraphMetadata)',
])

const subgraphMetadata = {
	displayName: 'Helico — 1inch Aqua on Arbitrum One',
	description:
		'Every 1inch Aqua ledger event on Arbitrum One — Shipped, Docked, Pulled, Pushed on the registry, Swapped on the SwapVM router — plus Helico account openings. Makers, mandates with a three-state balance (live, empty, docked), fills, and the accounts an enclave-run agent manages. Built for Helico, ETHOnline 2026.',
	codeRepository: 'https://github.com/0xHelico/helico/tree/main/subgraph',
	website: 'https://helico.site',
	categories: ['dex', 'defi', 'lending'],
	image: '',
}

const versionMetadata = {
	label: 'v0.3.0',
	description:
		'Adds the fifth Aqua event, Swapped, from the SwapVM router; indexes the Helico account factory.',
}

// ─── refusals ────────────────────────────────────────────────
if (process.env.CONFIRM !== 'publish') {
	console.error('Set CONFIRM=publish. Reading what this does and agreeing to it are two acts.')
	process.exit(1)
}
const key = process.env.PUBLISHER_KEY
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
	console.error(
		'PUBLISHER_KEY must be a 32-byte hex private key. It is read from the environment and never printed.',
	)
	process.exit(1)
}
const account = privateKeyToAccount(key as Hex)
const pub = createPublicClient({ chain: arbitrum, transport: http(RPC) })
const wallet = createWalletClient({ account, chain: arbitrum, transport: http(RPC) })

const chainId = await pub.getChainId()
if (chainId !== ARBITRUM_ONE) {
	console.error(`Expected Arbitrum One (42161), got ${chainId}.`)
	process.exit(1)
}
const nft = await pub.readContract({ abi: gnsAbi, address: L2GNS, functionName: 'subgraphNFT' })
if (nft.toLowerCase() !== SUBGRAPH_NFT.toLowerCase()) {
	console.error(
		`L2GNS answers subgraphNFT() = ${nft}, not the address The Graph's page lists. Stopping.`,
	)
	process.exit(1)
}

// ─── 1. the deployment Studio serves right now ──────────────
const meta = (await (
	await fetch(STUDIO, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ query: '{ _meta { deployment block { number } hasIndexingErrors } }' }),
	})
).json()) as {
	data?: { _meta?: { deployment: string; block: { number: number }; hasIndexingErrors: boolean } }
}
const deployment = meta.data?._meta?.deployment
if (!deployment || !deployment.startsWith('Qm')) {
	console.error('Studio did not answer with a deployment hash:', JSON.stringify(meta))
	process.exit(1)
}
if (meta.data?._meta?.hasIndexingErrors) {
	console.error('Studio reports indexing errors on this deployment. Not publishing a broken one.')
	process.exit(1)
}
console.log(`deployment   ${deployment}   (Studio, block ${meta.data?._meta?.block.number})`)

// ─── 2. the manifest is on The Graph's IPFS ─────────────────
const manifest = await (await fetch(`${IPFS}/cat?arg=${deployment}`, { method: 'POST' })).text()
if (
	!manifest.includes('dataSources:') ||
	!manifest.includes('0x1111113ccf1426a8e30e2bff5e005d929bf6a90a')
) {
	console.error(
		'The manifest on IPFS does not look like ours (no dataSources, or no Aqua address).',
	)
	process.exit(1)
}
console.log(`manifest     ${manifest.length} bytes on ${IPFS}, names Aqua`)

// ─── 3. pin the two metadata files ──────────────────────────
async function pin(name: string, body: object): Promise<string> {
	const form = new FormData()
	form.append('file', new Blob([JSON.stringify(body)], { type: 'application/json' }), name)
	const res = (await (await fetch(`${IPFS}/add`, { method: 'POST', body: form })).json()) as {
		Hash?: string
	}
	if (!res.Hash?.startsWith('Qm'))
		throw new Error(`pinning ${name} answered ${JSON.stringify(res)}`)
	// Read it back: a hash the node answers is a hash an indexer's node can fetch.
	const back = await (await fetch(`${IPFS}/cat?arg=${res.Hash}`, { method: 'POST' })).text()
	if (back !== JSON.stringify(body)) throw new Error(`${name} did not read back byte for byte`)
	return res.Hash
}
const subgraphMetaHash = await pin('subgraph.json', subgraphMetadata)
const versionMetaHash = await pin('version.json', versionMetadata)
console.log(`metadata     subgraph ${subgraphMetaHash}\n             version  ${versionMetaHash}`)

/** A CIDv0 (`Qm…`) is base58 of `0x12 0x20 <32-byte sha256>`; the contract wants the 32 bytes. */
function toBytes32(cid: string): Hex {
	const bytes = bs58.decode(cid)
	if (bytes.length !== 34 || bytes[0] !== 0x12 || bytes[1] !== 0x20)
		throw new Error(`${cid} is not a CIDv0 sha256 multihash`)
	return toHex(bytes.slice(2))
}
const deploymentID = toBytes32(deployment)

// ─── 4. publish ─────────────────────────────────────────────
const before = await pub.getBalance({ address: account.address })
console.log(`publisher    ${account.address}   ${formatEther(before)} ETH`)
const hash = await wallet.writeContract({
	abi: gnsAbi,
	address: L2GNS,
	functionName: 'publishNewSubgraph',
	args: [deploymentID, toBytes32(versionMetaHash), toBytes32(subgraphMetaHash)],
})
console.log(`tx           ${hash}`)
const receipt = await pub.waitForTransactionReceipt({ hash })
if (receipt.status !== 'success') {
	console.error('The transaction reverted. Nothing was published.')
	process.exit(1)
}

// ─── 5. read the id out of the receipt, not out of a guess ──
let subgraphID: bigint | undefined
for (const log of receipt.logs) {
	if (log.address.toLowerCase() !== L2GNS.toLowerCase()) continue
	try {
		const ev = decodeEventLog({ abi: gnsAbi, data: log.data, topics: log.topics })
		if (ev.eventName === 'SubgraphPublished') {
			subgraphID = ev.args.subgraphID
			if (ev.args.subgraphDeploymentID.toLowerCase() !== deploymentID.toLowerCase()) {
				console.error(
					'SubgraphPublished names a different deployment than the one sent. Stopping before saying anything true.',
				)
				process.exit(1)
			}
		}
	} catch {
		// another event of the contract
	}
}
if (subgraphID === undefined) {
	console.error(
		'The receipt has no SubgraphPublished event. Read it on Arbiscan before doing anything else:',
		hash,
	)
	process.exit(1)
}
const idBytes = new Uint8Array(32)
for (let i = 31, v = subgraphID; i >= 0; i--, v >>= 8n) idBytes[i] = Number(v & 0xffn)
const idBase58 = bs58.encode(idBytes)
const published = await pub.readContract({
	abi: gnsAbi,
	address: L2GNS,
	functionName: 'isPublished',
	args: [subgraphID],
})
const after = await pub.getBalance({ address: account.address })

console.log(`\nsubgraph id  ${idBase58}   (uint256 ${subgraphID})`)
console.log(`isPublished  ${published}`)
console.log(
	`block        ${receipt.blockNumber}   gas ${receipt.gasUsed}   cost ${formatEther(before - after)} ETH`,
)
console.log(
	`\nnext: BE_GRAPH_MCP_SUBGRAPH_ID=${idBase58} in the backend, and give the network's indexer a few minutes before asking the MCP for it.`,
)
