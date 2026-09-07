import { URVersion } from '@uniswap/v4-sdk'
import { getAddress } from 'viem'
import type { V4Addresses } from './addresses'

/**
 * v4 deployments the official SDKs do not list yet. Each entry says where the evidence came from.
 * Chains the SDKs know resolve from the SDKs; nothing here shadows them.
 */
export const knownDeployments: Record<number, V4Addresses> = {
	// Robinhood Chain Testnet (46630). PoolManager, Quoter, and StateView have bytecode identical
	// to mainnet at the same addresses; PositionManager, the Universal Router, and Permit2 have
	// code there too. Checked on 2026-09-05 against https://rpc.testnet.chain.robinhood.com/rpc.
	46630: {
		poolManager: getAddress('0x8366a39cc670b4001a1121b8f6a443a643e40951'),
		quoter: getAddress('0x8dc178efb8111bb0973dd9d722ebeff267c98f94'),
		stateView: getAddress('0xf3334192d15450cdd385c8b70e03f9a6bd9e673b'),
		positionManager: getAddress('0x58daec3116aae6d93017baaea7749052e8a04fa7'),
		universalRouter: getAddress('0x8876789976decbfcbbbe364623c63652db8c0904'),
		universalRouterVersion: URVersion.V2_1_1,
		permit2: getAddress('0x000000000022D473030F116dDEE9F6B43aC78BA3'),
	},
}
