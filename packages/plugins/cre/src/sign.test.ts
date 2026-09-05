import { describe, expect, test } from 'bun:test'
import {
	concatHex,
	decodeAbiParameters,
	encodeAbiParameters,
	type Hex,
	keccak256,
	parseAbiParameters,
	stringToHex,
} from 'viem'
import { recenterParamsAbi } from './abi'
import { encodeRecenterWithSignature } from './relay'
import {
	type Authorisation,
	encodeAuthorisation,
	type RecentreDomain,
	recentreDigest,
	recoverRecentreSigner,
	signRecentre,
} from './sign'

// Anvil's first account, a public test key.
const key = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const keyAddress = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

const domain: RecentreDomain = {
	name: 'HelicoVault',
	version: '1',
	chainId: 4663,
	verifyingContract: '0x1111111111111111111111111111111111111111',
}
const auth: Authorisation = {
	params: {
		owner: '0x746182D0Cccc5CeFc69853bb0325C850029388C0',
		tickLower: -560,
		tickUpper: 440,
		liquidityToMint: 129_997_405_203_692n,
		amount0Min: 3_234_967_638_235n,
		amount1Min: 45_299_872_474_506n,
		amount0Max: 3_251_223_757_021n,
		amount1Max: 45_527_510_024_630n,
		zeroForOne: true,
		amountIn: 1_000_000_000_000n,
		minAmountOut: 995_000_000_000n,
		deadline: 1_700_000_600n,
	},
	mandateHash: '0x134be6bb4e1c442551c22dfe96cb5b7c3c31babb386e2e9a051e57ee329a6225',
	nonce: 1n,
}

/** EIP-712 by hand, the way the vault will do it in Solidity, so viem is checked against the spec rather than itself. */
const digestBySpec = (): Hex => {
	const paramsType =
		'RecenterParams(address owner,int24 tickLower,int24 tickUpper,uint256 liquidityToMint,uint128 amount0Min,uint128 amount1Min,uint128 amount0Max,uint128 amount1Max,bool zeroForOne,uint256 amountIn,uint256 minAmountOut,uint256 deadline)'
	const recenterType = `Recenter(RecenterParams params,bytes32 mandateHash,uint256 nonce)${paramsType}`
	const p = auth.params
	const paramsHash = keccak256(
		encodeAbiParameters(
			parseAbiParameters(
				'bytes32, address, int24, int24, uint256, uint128, uint128, uint128, uint128, bool, uint256, uint256, uint256',
			),
			[
				keccak256(stringToHex(paramsType)),
				p.owner,
				p.tickLower,
				p.tickUpper,
				p.liquidityToMint,
				p.amount0Min,
				p.amount1Min,
				p.amount0Max,
				p.amount1Max,
				p.zeroForOne,
				p.amountIn,
				p.minAmountOut,
				p.deadline,
			],
		),
	)
	const structHash = keccak256(
		encodeAbiParameters(parseAbiParameters('bytes32, bytes32, bytes32, uint256'), [
			keccak256(stringToHex(recenterType)),
			paramsHash,
			auth.mandateHash,
			auth.nonce,
		]),
	)
	const domainSeparator = keccak256(
		encodeAbiParameters(parseAbiParameters('bytes32, bytes32, bytes32, uint256, address'), [
			keccak256(
				stringToHex(
					'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)',
				),
			),
			keccak256(stringToHex(domain.name)),
			keccak256(stringToHex(domain.version)),
			BigInt(domain.chainId),
			domain.verifyingContract,
		]),
	)
	return keccak256(concatHex(['0x1901', domainSeparator, structHash]))
}

describe('recentreDigest', () => {
	test('equals the EIP-712 digest computed by hand from the type strings the vault will hash', () => {
		expect(recentreDigest(domain, auth)).toBe(digestBySpec())
	})

	test('changes with the nonce, the mandate hash, the params, and the domain', () => {
		const d = recentreDigest(domain, auth)
		expect(recentreDigest(domain, { ...auth, nonce: 2n })).not.toBe(d)
		expect(recentreDigest(domain, { ...auth, mandateHash: `0x${'ab'.repeat(32)}` })).not.toBe(d)
		expect(recentreDigest(domain, { ...auth, params: { ...auth.params, amountIn: 1n } })).not.toBe(
			d,
		)
		expect(recentreDigest({ ...domain, chainId: 46630 }, auth)).not.toBe(d)
	})
})

describe('signRecentre', () => {
	test('signs deterministically with the agent key and recovers to its address', async () => {
		const a = await signRecentre(key, domain, auth)
		const b = await signRecentre(key, domain, auth)
		expect(a.signer).toBe(keyAddress)
		expect(a.signature).toBe(b.signature)
		expect(a.signature).toHaveLength(2 + 65 * 2)
		expect(await recoverRecentreSigner(domain, auth, a.signature)).toBe(keyAddress)
		// A signature over a different nonce does not recover to the agent for this one.
		const other = await signRecentre(key, domain, { ...auth, nonce: 2n })
		expect(await recoverRecentreSigner(domain, auth, other.signature)).not.toBe(keyAddress)
	})
})

describe('encodeAuthorisation', () => {
	test('round-trips as (RecenterParams, bytes32, uint256, bytes)', async () => {
		const { signature } = await signRecentre(key, domain, auth)
		const [p, hash, nonce, sig] = decodeAbiParameters(
			[recenterParamsAbi, { type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes' }],
			encodeAuthorisation(auth, signature),
		)
		expect(p).toEqual(auth.params)
		expect(hash).toBe(auth.mandateHash)
		expect(nonce).toBe(1n)
		expect(sig).toBe(signature)
	})
})

describe('encodeRecenterWithSignature', () => {
	test('builds calldata for the named vault function with the tuple, hash, nonce, and signature', async () => {
		const { signature } = await signRecentre(key, domain, auth)
		const data = encodeRecenterWithSignature('recenterWithSignature', auth, signature)
		expect(data.startsWith('0x')).toBe(true)
		// selector + a static tuple of 12 words + hash + nonce + offset of bytes + length + 3 words of signature
		expect(data.length).toBe(2 + 8 + (12 + 1 + 1 + 1 + 1 + 3) * 64)
	})
})
