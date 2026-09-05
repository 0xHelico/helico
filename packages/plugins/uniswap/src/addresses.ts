import { PERMIT2_ADDRESS } from '@uniswap/permit2-sdk'
import { CHAIN_TO_ADDRESSES_MAP } from '@uniswap/sdk-core'
import { UNIVERSAL_ROUTER_ADDRESS, UniversalRouterVersion } from '@uniswap/universal-router-sdk'
import { type Address, getAddress } from 'viem'

export type V4Addresses = {
	poolManager: Address
	quoter: Address
	stateView: Address
	positionManager: Address
	universalRouter: Address
	permit2: Address
}

type SdkEntry = {
	v4PoolManagerAddress?: string
	v4QuoterAddress?: string
	v4StateView?: string
	v4PositionManagerAddress?: string
}

const sdkMap = CHAIN_TO_ADDRESSES_MAP as unknown as Record<string, SdkEntry | undefined>

const universalRouterOf = (chainId: number): Address | undefined => {
	try {
		return getAddress(UNIVERSAL_ROUTER_ADDRESS(UniversalRouterVersion.V2_0, chainId))
	} catch {
		return undefined
	}
}

/** Chains where the SDKs know every v4 contract this package uses. */
export function supportedChainIds(): number[] {
	return Object.keys(sdkMap)
		.map(Number)
		.filter((chainId) => {
			const entry = sdkMap[chainId]
			return Boolean(
				entry?.v4PoolManagerAddress &&
					entry.v4QuoterAddress &&
					entry.v4StateView &&
					entry.v4PositionManagerAddress &&
					universalRouterOf(chainId),
			)
		})
		.sort((a, b) => a - b)
}

/** Checksummed v4 contract addresses as shipped inside the official SDKs. Throws where v4 is not deployed. */
export function addresses(chainId: number): V4Addresses {
	const entry = sdkMap[chainId]
	const universalRouter = universalRouterOf(chainId)
	if (
		!entry?.v4PoolManagerAddress ||
		!entry.v4QuoterAddress ||
		!entry.v4StateView ||
		!entry.v4PositionManagerAddress ||
		!universalRouter
	) {
		throw new Error(`Uniswap v4 is not deployed on chain ${chainId} according to @uniswap/sdk-core`)
	}
	return {
		poolManager: getAddress(entry.v4PoolManagerAddress),
		quoter: getAddress(entry.v4QuoterAddress),
		stateView: getAddress(entry.v4StateView),
		positionManager: getAddress(entry.v4PositionManagerAddress),
		universalRouter,
		permit2: getAddress(PERMIT2_ADDRESS),
	}
}
