import { CHAIN_TO_ADDRESSES_MAP } from '@uniswap/sdk-core'
import {
	CommandType,
	RoutePlanner,
	UNIVERSAL_ROUTER_ADDRESS,
	UniversalRouterVersion,
} from '@uniswap/universal-router-sdk'
import { Actions, V4Planner } from '@uniswap/v4-sdk'
import {
	type Address,
	encodeAbiParameters,
	encodeFunctionData,
	type Hex,
	keccak256,
	type PublicClient,
	parseAbi,
	zeroAddress,
} from 'viem'

export type PoolKey = {
	currency0: Address
	currency1: Address
	fee: number
	tickSpacing: number
	hooks: Address
}

export type V4Addresses = {
	poolManager: Address
	quoter: Address
	stateView: Address
	universalRouter: Address
}

type SdkAddresses = Record<
	number,
	{ v4PoolManagerAddress?: string; v4QuoterAddress?: string; v4StateView?: string } | undefined
>

/** v4 contract addresses as shipped inside the official SDKs. Throws where v4 is not deployed. */
export function addresses(chainId: number): V4Addresses {
	const entry = (CHAIN_TO_ADDRESSES_MAP as unknown as SdkAddresses)[chainId]
	if (!entry?.v4PoolManagerAddress || !entry.v4QuoterAddress || !entry.v4StateView) {
		throw new Error(`Uniswap v4 is not deployed on chain ${chainId} according to @uniswap/sdk-core`)
	}
	return {
		poolManager: entry.v4PoolManagerAddress as Address,
		quoter: entry.v4QuoterAddress as Address,
		stateView: entry.v4StateView as Address,
		universalRouter: UNIVERSAL_ROUTER_ADDRESS(UniversalRouterVersion.V2_0, chainId) as Address,
	}
}

/** keccak256(abi.encode(poolKey)), the same derivation as PoolIdLibrary.toId in v4-core. */
export function poolId(key: PoolKey): Hex {
	return keccak256(
		encodeAbiParameters(
			[
				{ type: 'address' },
				{ type: 'address' },
				{ type: 'uint24' },
				{ type: 'int24' },
				{ type: 'address' },
			],
			[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
		),
	)
}

const stateViewAbi = parseAbi([
	'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
	'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
])

const quoterAbi = parseAbi([
	'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
	'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
	'function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)',
])

const universalRouterAbi = parseAbi([
	'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
])

const chainIdOf = (client: PublicClient) => client.chain?.id ?? client.getChainId()

/** Pool price and liquidity from StateView. */
export async function getPoolState(client: PublicClient, key: PoolKey) {
	const { stateView } = addresses(await chainIdOf(client))
	const id = poolId(key)
	const [[sqrtPriceX96, tick, protocolFee, lpFee], liquidity] = await Promise.all([
		client.readContract({
			address: stateView,
			abi: stateViewAbi,
			functionName: 'getSlot0',
			args: [id],
		}),
		client.readContract({
			address: stateView,
			abi: stateViewAbi,
			functionName: 'getLiquidity',
			args: [id],
		}),
	])
	return { poolId: id, sqrtPriceX96, tick, protocolFee, lpFee, liquidity }
}

export type QuoteInput = {
	poolKey: PoolKey
	zeroForOne: boolean
	amountIn: bigint
	hookData?: Hex
}

/** Exact-input quote from the v4 Quoter. A read-only eth_call, nothing is sent. */
export async function quoteExactInputSingle(
	client: PublicClient,
	{ poolKey, zeroForOne, amountIn, hookData = '0x' }: QuoteInput,
) {
	const { quoter } = addresses(await chainIdOf(client))
	const { result } = await client.simulateContract({
		address: quoter,
		abi: quoterAbi,
		functionName: 'quoteExactInputSingle',
		args: [{ poolKey, zeroForOne, exactAmount: amountIn, hookData }],
	})
	const [amountOut, gasEstimate] = result
	return { amountOut, gasEstimate }
}

export type SwapInput = QuoteInput & {
	chainId: number
	amountOutMinimum: bigint
	deadline: bigint
}

/**
 * Universal Router calldata for a single-hop v4 exact-input swap. Nothing is signed or sent.
 * Native ETH input is paid through `value`; an ERC-20 input needs Permit2 approvals first.
 */
export function encodeSwapExactInSingle({
	chainId,
	poolKey,
	zeroForOne,
	amountIn,
	amountOutMinimum,
	deadline,
	hookData = '0x',
}: SwapInput) {
	const [input, output] = zeroForOne
		? [poolKey.currency0, poolKey.currency1]
		: [poolKey.currency1, poolKey.currency0]
	const planner = new V4Planner()
	planner.addAction(Actions.SWAP_EXACT_IN_SINGLE, [
		{
			poolKey,
			zeroForOne,
			amountIn: amountIn.toString(),
			amountOutMinimum: amountOutMinimum.toString(),
			hookData,
		},
	])
	planner.addAction(Actions.SETTLE_ALL, [input, amountIn.toString()])
	planner.addAction(Actions.TAKE_ALL, [output, amountOutMinimum.toString()])
	const route = new RoutePlanner()
	route.addCommand(CommandType.V4_SWAP, [planner.actions, planner.params])
	// The router wants V4Planner.finalize() as the V4_SWAP input, not RoutePlanner.inputs,
	// which came back as three bytes and reverted in eth_call on Base.
	const data = encodeFunctionData({
		abi: universalRouterAbi,
		functionName: 'execute',
		args: [route.commands as Hex, [planner.finalize() as Hex], deadline],
	})
	return {
		to: addresses(chainId).universalRouter,
		data,
		value: input === zeroAddress ? amountIn : 0n,
	}
}
