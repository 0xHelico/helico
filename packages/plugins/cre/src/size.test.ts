import { describe, expect, test } from 'bun:test'
import { decodeAbiParameters } from 'viem'
import { recenterParamsAbi } from './abi'
import { encodeRecenterParams, parseArgs, sizeForState } from './size'

// The live testnet ETH/WETH pool at tick -65, with a deep pool to swap through.
const state = {
	sqrtPriceX96: 78_971_408_793_868_239_585_893_302_751n,
	tick: -65,
	poolLiquidity: 10n ** 18n,
	feePips: 500,
	tickSpacing: 10,
	liquidity: 10n ** 15n,
	tickLower: 100,
	tickUpper: 1_100,
	rangeWidthTicks: 1000,
	slippageBps: 50,
}

describe('sizeForState', () => {
	test('proposes the range decide would and sizes the swap for it', () => {
		const sized = sizeForState(state)
		expect(sized.proposed).toEqual({ tickLower: -560, tickUpper: 440 })
		expect(sized.vault).toBeNull()
		expect(sized.sizing.zeroForOne).toBe(true)
		expect(sized.sizing.amountIn).toBeGreaterThan(0n)
		expect(sized.sizing.liquidityToMint).toBeGreaterThan(0n)
	})

	test('reports why the vault would refuse a range instead of hiding it', () => {
		expect(sizeForState({ ...state, rangeWidthTicks: 1_005 }).vault).toBe('TicksNotSpaced')
	})
})

describe('encodeRecenterParams', () => {
	test('encodes the vault struct in its field order', () => {
		const sized = sizeForState(state)
		const owner = '0x746182D0Cccc5CeFc69853bb0325C850029388C0'
		const [p] = decodeAbiParameters(
			[recenterParamsAbi],
			encodeRecenterParams(sized, { owner, deadline: 1_700_000_600n }),
		)
		expect(p.owner).toBe(owner)
		expect([p.tickLower, p.tickUpper]).toEqual([-560, 440])
		expect(p.amountIn).toBe(sized.sizing.amountIn)
		expect(p.liquidityToMint).toBe(sized.sizing.liquidityToMint)
		expect(p.deadline).toBe(1_700_000_600n)
	})
})

describe('parseArgs', () => {
	const argv = [
		'--sqrt-price=78971408793868239585893302751',
		'--tick=-65',
		'--pool-liquidity=1000000000000000000',
		'--fee=500',
		'--spacing=10',
		'--liquidity=1000000000000000',
		'--lower=100',
		'--upper=1100',
		'--width=1000',
		'--slippage=50',
	]

	test('reads every field and the optional encoding inputs', () => {
		expect(parseArgs(argv).state).toEqual(state)
		expect(parseArgs(argv).encode).toBeUndefined()
		const withOwner = parseArgs([
			...argv,
			'--owner=0x746182d0cccc5cefc69853bb0325c850029388c0',
			'--deadline=1700000600',
			'--abi',
		])
		expect(withOwner.encode?.owner).toBe('0x746182D0Cccc5CeFc69853bb0325C850029388C0')
		expect(withOwner.abi).toBe(true)
	})

	test('refuses a missing or malformed field', () => {
		expect(() => parseArgs(argv.slice(1))).toThrow('Missing --sqrt-price')
		expect(() => parseArgs([...argv.slice(0, 1), '--tick=1.5', ...argv.slice(2)])).toThrow(
			'--tick must be an integer',
		)
	})
})
