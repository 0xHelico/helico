/**
 * Prints what the enclave would size for an explicit chain state, so a Foundry fork test can
 * build that state and hold the vault to the same numbers (`vm.ffi`), or a reviewer can paste
 * them. Package script, not part of the workflow bundle.
 *
 *   bun src/size.ts --sqrt-price=<uint160> --tick=<int24> --pool-liquidity=<uint128> --fee=<pips> \
 *     --spacing=<int24> --liquidity=<uint128> --lower=<int24> --upper=<int24> --width=<ticks> \
 *     --slippage=<bps> [--owner=<address> --deadline=<unix>] [--abi]
 *
 * `--abi` prints only the ABI-encoded `RecenterParams`, which is what `vm.ffi` wants.
 */
import { type Address, encodeAbiParameters, getAddress, type Hex } from 'viem'
import { recenterParamsAbi } from './abi'
import { nearestUsableTick, type Range, type VaultRejection, vaultRejects } from './decision'
import { type Sizing, sizeRecentre } from './sizing'

export type StateInput = {
	sqrtPriceX96: bigint
	tick: number
	poolLiquidity: bigint
	feePips: number
	tickSpacing: number
	liquidity: bigint
	tickLower: number
	tickUpper: number
	rangeWidthTicks: number
	slippageBps: number
}

export type SizedRecentre = {
	proposed: Range
	/** Why the vault would refuse the proposed range, or null; sizing is reported either way. */
	vault: VaultRejection | null
	sizing: Sizing
}

/** The same range and sizing `decide` would produce, minus its policy holds. */
export function sizeForState(s: StateInput): SizedRecentre {
	const tickLower = nearestUsableTick(s.tick - Math.floor(s.rangeWidthTicks / 2), s.tickSpacing)
	const proposed = { tickLower, tickUpper: tickLower + s.rangeWidthTicks }
	const current = { tickLower: s.tickLower, tickUpper: s.tickUpper }
	return {
		proposed,
		vault: vaultRejects({
			tick: s.tick,
			tickSpacing: s.tickSpacing,
			current,
			proposed,
			mandate: { rangeWidthTicks: s.rangeWidthTicks, minImprovementBps: 0 },
		}),
		sizing: sizeRecentre({
			liquidity: s.liquidity,
			sqrtPriceX96: s.sqrtPriceX96,
			current,
			proposed,
			poolLiquidity: s.poolLiquidity,
			feePips: s.feePips,
			slippageBps: s.slippageBps,
		}),
	}
}

export type EncodeInput = { owner: Address; deadline: bigint }

/** `abi.encode(RecenterParams)` for the vault, from a sizing. */
export function encodeRecenterParams(
	{ proposed, sizing }: SizedRecentre,
	{ owner, deadline }: EncodeInput,
): Hex {
	return encodeAbiParameters(
		[recenterParamsAbi],
		[
			{
				owner,
				tickLower: proposed.tickLower,
				tickUpper: proposed.tickUpper,
				liquidityToMint: sizing.liquidityToMint,
				amount0Min: sizing.amount0Min,
				amount1Min: sizing.amount1Min,
				amount0Max: sizing.amount0Max,
				amount1Max: sizing.amount1Max,
				zeroForOne: sizing.zeroForOne,
				amountIn: sizing.amountIn,
				minAmountOut: sizing.minAmountOut,
				deadline,
			},
		],
	)
}

const NUMBER_KEYS = ['tick', 'fee', 'spacing', 'lower', 'upper', 'width', 'slippage'] as const
const BIGINT_KEYS = ['sqrt-price', 'pool-liquidity', 'liquidity'] as const

/** `--key=value` pairs into a state; every numeric key is required, `--owner`/`--deadline` optional. */
export function parseArgs(argv: string[]): {
	state: StateInput
	encode?: EncodeInput
	abi: boolean
} {
	const raw = new Map<string, string>()
	for (const arg of argv) {
		const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg)
		if (!m) throw new Error(`Unexpected argument ${arg}`)
		raw.set(m[1] as string, m[2] ?? 'true')
	}
	const need = (key: string): string => {
		const v = raw.get(key)
		if (v === undefined) throw new Error(`Missing --${key}`)
		return v
	}
	const int = (key: string): number => {
		const n = Number(need(key))
		if (!Number.isInteger(n)) throw new Error(`--${key} must be an integer`)
		return n
	}
	const big = (key: string): bigint => {
		const v = need(key)
		if (!/^\d+$/.test(v)) throw new Error(`--${key} must be an unsigned integer`)
		return BigInt(v)
	}
	for (const k of NUMBER_KEYS) need(k)
	for (const k of BIGINT_KEYS) need(k)
	const state: StateInput = {
		sqrtPriceX96: big('sqrt-price'),
		tick: int('tick'),
		poolLiquidity: big('pool-liquidity'),
		feePips: int('fee'),
		tickSpacing: int('spacing'),
		liquidity: big('liquidity'),
		tickLower: int('lower'),
		tickUpper: int('upper'),
		rangeWidthTicks: int('width'),
		slippageBps: int('slippage'),
	}
	const owner = raw.get('owner')
	const deadline = raw.get('deadline')
	const encode =
		owner && deadline ? { owner: getAddress(owner), deadline: BigInt(deadline) } : undefined
	return { state, encode, abi: raw.get('abi') === 'true' }
}

const json = (value: unknown): string =>
	JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)

if (import.meta.main) {
	const { state, encode, abi } = parseArgs(process.argv.slice(2))
	const sized = sizeForState(state)
	if (abi) {
		if (!encode) throw new Error('--abi needs --owner and --deadline')
		process.stdout.write(encodeRecenterParams(sized, encode))
	} else {
		process.stdout.write(
			`${json({ ...sized, encoded: encode ? encodeRecenterParams(sized, encode) : undefined })}
`,
		)
	}
}
