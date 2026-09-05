import { CommandType, RoutePlanner } from '@uniswap/universal-router-sdk'
import { Actions, V4Planner } from '@uniswap/v4-sdk'
import { type Address, encodeFunctionData, type Hex, zeroAddress } from 'viem'
import { universalRouterAbi } from './abi/universalRouter'
import { addresses } from './addresses'
import type { PathKey, PoolKey, PoolParams, Transaction } from './types'

/** `address(1)`: the Universal Router resolves this recipient to the caller. */
export const MSG_SENDER: Address = '0x0000000000000000000000000000000000000001'

const BPS = 10_000n

/** Lowest acceptable amount after `slippageBps` basis points of slippage. */
export function minimumAfterSlippage(amount: bigint, slippageBps: number): bigint {
	return amount - (amount * BigInt(slippageBps)) / BPS
}

/** Highest acceptable amount after `slippageBps` basis points of slippage. */
export function maximumAfterSlippage(amount: bigint, slippageBps: number): bigint {
	return amount + (amount * BigInt(slippageBps)) / BPS
}

/** Unix timestamp `seconds` from now, as the router expects it. */
export function deadlineFromNow(seconds: number, nowMs = Date.now()): bigint {
	return BigInt(Math.floor(nowMs / 1000) + seconds)
}

export type Route = {
	/** Currencies in trade order, input first. */
	currencies: Address[]
	/** One entry per hop, `pools[i]` joins `currencies[i]` and `currencies[i + 1]`. */
	pools: PoolParams[]
}

export type BuiltPath = {
	currencyIn: Address
	currencyOut: Address
	/** For exact-input: the hops after `currencyIn`. */
	exactInPath: PathKey[]
	/** For exact-output: the hops before `currencyOut`, starting with the input currency. */
	exactOutPath: PathKey[]
}

const toPathKey = (currency: Address, pool: PoolParams): PathKey => ({
	intermediateCurrency: currency,
	fee: pool.fee,
	tickSpacing: pool.tickSpacing,
	hooks: pool.hooks ?? zeroAddress,
	hookData: pool.hookData ?? '0x',
})

/** Turns a currency list into the two path orders the router and the Quoter read. */
export function buildPath({ currencies, pools }: Route): BuiltPath {
	if (currencies.length < 2 || pools.length !== currencies.length - 1) {
		throw new Error('A route needs n currencies and n - 1 pools')
	}
	return {
		currencyIn: currencies[0] as Address,
		currencyOut: currencies.at(-1) as Address,
		exactInPath: pools.map((pool, i) => toPathKey(currencies[i + 1] as Address, pool)),
		exactOutPath: pools.map((pool, i) => toPathKey(currencies[i] as Address, pool)),
	}
}

const toPlannerPath = (path: PathKey[]) =>
	path.map((hop) => ({
		intermediateCurrency: hop.intermediateCurrency,
		fee: hop.fee,
		tickSpacing: hop.tickSpacing,
		hooks: hop.hooks,
		hookData: hop.hookData,
	}))

type Settlement = {
	chainId: number
	deadline: bigint
	currencyIn: Address
	currencyOut: Address
	/** What the router may take from the caller: the exact input, or the maximum for exact-output. */
	settleAmount: bigint
	/** What the caller must receive: the minimum for exact-input, or the exact output. */
	takeAmount: bigint
	/** Exact-output swaps may not use the whole native input; the rest is swept back. */
	exactOutput: boolean
}

/**
 * Closes the deltas and wraps the actions into a Universal Router `execute` call.
 * The V4_SWAP input has to be `V4Planner.finalize()`; `RoutePlanner.inputs` is not it.
 * A native-input exact-output swap may leave ETH in the router, so a router-level SWEEP
 * command returns it to the caller (the v4 action set has no sweep; the router rejects it).
 */
function executeSwap(planner: V4Planner, s: Settlement): Transaction {
	planner.addAction(Actions.SETTLE_ALL, [s.currencyIn, s.settleAmount.toString()])
	planner.addAction(Actions.TAKE_ALL, [s.currencyOut, s.takeAmount.toString()])
	const payWithNative = s.currencyIn === zeroAddress
	const route = new RoutePlanner()
	route.addCommand(CommandType.V4_SWAP, [planner.actions, planner.params])
	const inputs: Hex[] = [planner.finalize() as Hex]
	if (payWithNative && s.exactOutput) {
		route.addCommand(CommandType.SWEEP, [zeroAddress, MSG_SENDER, 0])
		inputs.push(route.inputs[1] as Hex)
	}
	const data = encodeFunctionData({
		abi: universalRouterAbi,
		functionName: 'execute',
		args: [route.commands as Hex, inputs, s.deadline],
	})
	return {
		to: addresses(s.chainId).universalRouter,
		data,
		value: payWithNative ? s.settleAmount : 0n,
	}
}

const direction = (poolKey: PoolKey, zeroForOne: boolean): [Address, Address] =>
	zeroForOne ? [poolKey.currency0, poolKey.currency1] : [poolKey.currency1, poolKey.currency0]

export type SingleHopSwapInput = {
	chainId: number
	poolKey: PoolKey
	zeroForOne: boolean
	deadline: bigint
	hookData?: Hex
}

/** Exact input through one pool. Native input is paid through `value`. */
export function encodeSwapExactInSingle({
	chainId,
	poolKey,
	zeroForOne,
	amountIn,
	amountOutMinimum,
	deadline,
	hookData = '0x',
}: SingleHopSwapInput & { amountIn: bigint; amountOutMinimum: bigint }): Transaction {
	const [currencyIn, currencyOut] = direction(poolKey, zeroForOne)
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
	return executeSwap(planner, {
		chainId,
		deadline,
		currencyIn,
		currencyOut,
		settleAmount: amountIn,
		takeAmount: amountOutMinimum,
		exactOutput: false,
	})
}

/** Exact output through one pool. Unused native input is swept back to the caller. */
export function encodeSwapExactOutSingle({
	chainId,
	poolKey,
	zeroForOne,
	amountOut,
	amountInMaximum,
	deadline,
	hookData = '0x',
}: SingleHopSwapInput & { amountOut: bigint; amountInMaximum: bigint }): Transaction {
	const [currencyIn, currencyOut] = direction(poolKey, zeroForOne)
	const planner = new V4Planner()
	planner.addAction(Actions.SWAP_EXACT_OUT_SINGLE, [
		{
			poolKey,
			zeroForOne,
			amountOut: amountOut.toString(),
			amountInMaximum: amountInMaximum.toString(),
			hookData,
		},
	])
	return executeSwap(planner, {
		chainId,
		deadline,
		currencyIn,
		currencyOut,
		settleAmount: amountInMaximum,
		takeAmount: amountOut,
		exactOutput: true,
	})
}

export type MultiHopSwapInput = {
	chainId: number
	deadline: bigint
}

/** Exact input along `exactInPath` from `buildPath`. */
export function encodeSwapExactIn({
	chainId,
	currencyIn,
	currencyOut,
	path,
	amountIn,
	amountOutMinimum,
	deadline,
}: MultiHopSwapInput & {
	currencyIn: Address
	currencyOut: Address
	path: PathKey[]
	amountIn: bigint
	amountOutMinimum: bigint
}): Transaction {
	const planner = new V4Planner()
	planner.addAction(Actions.SWAP_EXACT_IN, [
		{
			currencyIn,
			path: toPlannerPath(path),
			amountIn: amountIn.toString(),
			amountOutMinimum: amountOutMinimum.toString(),
		},
	])
	return executeSwap(planner, {
		chainId,
		deadline,
		currencyIn,
		currencyOut,
		settleAmount: amountIn,
		takeAmount: amountOutMinimum,
		exactOutput: false,
	})
}

/** Exact output along `exactOutPath` from `buildPath`. */
export function encodeSwapExactOut({
	chainId,
	currencyIn,
	currencyOut,
	path,
	amountOut,
	amountInMaximum,
	deadline,
}: MultiHopSwapInput & {
	currencyIn: Address
	currencyOut: Address
	path: PathKey[]
	amountOut: bigint
	amountInMaximum: bigint
}): Transaction {
	const planner = new V4Planner()
	planner.addAction(Actions.SWAP_EXACT_OUT, [
		{
			currencyOut,
			path: toPlannerPath(path),
			amountOut: amountOut.toString(),
			amountInMaximum: amountInMaximum.toString(),
		},
	])
	return executeSwap(planner, {
		chainId,
		deadline,
		currencyIn,
		currencyOut,
		settleAmount: amountInMaximum,
		takeAmount: amountOut,
		exactOutput: true,
	})
}
