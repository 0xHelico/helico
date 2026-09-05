import { PERMIT2_ADDRESS } from '@uniswap/permit2-sdk'
import { CHAIN_TO_ADDRESSES_MAP } from '@uniswap/sdk-core'
import { UNIVERSAL_ROUTER_ADDRESS, UniversalRouterVersion } from '@uniswap/universal-router-sdk'
import { URVersion } from '@uniswap/v4-sdk'
import { type Address, getAddress } from 'viem'
import { knownDeployments } from './deployments'

export type V4Addresses = {
	poolManager: Address
	quoter: Address
	stateView: Address
	positionManager: Address
	universalRouter: Address
	/** Routers from 2.1.1 on read different v4 swap structs; the encoders follow this. */
	universalRouterVersion: URVersion
	permit2: Address
}

type SdkEntry = {
	v4PoolManagerAddress?: string
	v4QuoterAddress?: string
	v4StateView?: string
	v4PositionManagerAddress?: string
}

const sdkMap = CHAIN_TO_ADDRESSES_MAP as unknown as Record<string, SdkEntry | undefined>

/** Oldest first: 2.0 is the proven path; newer routers only where 2.0 was never deployed. */
const ROUTER_PREFERENCE: [UniversalRouterVersion, URVersion][] = [
	[UniversalRouterVersion.V2_0, URVersion.V2_0],
	[UniversalRouterVersion.V2_1_1, URVersion.V2_1_1],
	[UniversalRouterVersion.V2_2_0, URVersion.V2_2_0],
]

const universalRouterOf = (
	chainId: number,
): { address: Address; version: URVersion } | undefined => {
	for (const [sdkVersion, version] of ROUTER_PREFERENCE) {
		try {
			return { address: getAddress(UNIVERSAL_ROUTER_ADDRESS(sdkVersion, chainId)), version }
		} catch {}
	}
	return undefined
}

const fromSdk = (chainId: number): V4Addresses | undefined => {
	const entry = sdkMap[chainId]
	const router = universalRouterOf(chainId)
	if (
		!entry?.v4PoolManagerAddress ||
		!entry.v4QuoterAddress ||
		!entry.v4StateView ||
		!entry.v4PositionManagerAddress ||
		!router
	) {
		return undefined
	}
	return {
		poolManager: getAddress(entry.v4PoolManagerAddress),
		quoter: getAddress(entry.v4QuoterAddress),
		stateView: getAddress(entry.v4StateView),
		positionManager: getAddress(entry.v4PositionManagerAddress),
		universalRouter: router.address,
		universalRouterVersion: router.version,
		permit2: getAddress(PERMIT2_ADDRESS),
	}
}

const registered = new Map<number, V4Addresses>(
	Object.entries(knownDeployments).map(([id, a]) => [Number(id), a]),
)

const normalize = (a: V4Addresses): V4Addresses => ({
	poolManager: getAddress(a.poolManager),
	quoter: getAddress(a.quoter),
	stateView: getAddress(a.stateView),
	positionManager: getAddress(a.positionManager),
	universalRouter: getAddress(a.universalRouter),
	universalRouterVersion: a.universalRouterVersion,
	permit2: getAddress(a.permit2),
})

/**
 * Makes any chain usable: register its v4 deployment once and every read, quote, swap, and
 * liquidity builder resolves it. A registration wins over the SDK's entry for that chain.
 */
export function registerV4Addresses(chainId: number, deployment: V4Addresses): void {
	registered.set(chainId, normalize(deployment))
}

/** Chains where every v4 contract this package uses is known: registered, or from the SDKs. */
export function supportedChainIds(): number[] {
	const ids = new Set<number>(registered.keys())
	for (const key of Object.keys(sdkMap)) if (fromSdk(Number(key))) ids.add(Number(key))
	return [...ids].sort((a, b) => a - b)
}

/** Checksummed v4 contract addresses. Throws where v4 is not known. */
export function addresses(chainId: number): V4Addresses {
	const found = registered.get(chainId) ?? fromSdk(chainId)
	if (!found) {
		throw new Error(
			`Uniswap v4 is not known on chain ${chainId}: not in @uniswap/sdk-core and not registered with registerV4Addresses()`,
		)
	}
	return found
}
