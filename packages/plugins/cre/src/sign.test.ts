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
import { idleMoveParamsAbi } from './abi'
import { encodeIdleMove } from './relay'
import {
	type Authorisation,
	encodeAuthorisation,
	type IdleMoveDomain,
	idleMoveDigest,
	recoverIdleMoveSigner,
	signIdleMove,
} from './sign'

// Anvil's first account, a public test key.
const key = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const keyAddress = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

const account = '0x1111111111111111111111111111111111111111'
const pool = '0x794a61358D6845594F94dc1DB02A252b5b4814aD'
const usdc = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'

const domain: IdleMoveDomain = {
	name: 'HelicoAccount',
	version: '1',
	chainId: 42_161,
	verifyingContract: account,
}
const auth: Authorisation = {
	params: {
		account,
		pool,
		asset: usdc,
		amount: 800_000_000n,
		supply: true,
		deadline: 1_700_000_600n,
	},
	policyHash: '0x63252eb3d00b4713a7ae923551b77107f12c2aa057b94494fda994b235499584',
	nonce: 1n,
}

/** EIP-712 by hand from the type strings, so viem is checked against the spec rather than itself. */
const digestBySpec = (): Hex => {
	const paramsType =
		'IdleMoveParams(address account,address pool,address asset,uint256 amount,bool supply,uint256 deadline)'
	const moveType = `IdleMove(IdleMoveParams params,bytes32 policyHash,uint256 nonce)${paramsType}`
	const p = auth.params
	const paramsHash = keccak256(
		encodeAbiParameters(
			parseAbiParameters('bytes32, address, address, address, uint256, bool, uint256'),
			[
				keccak256(stringToHex(paramsType)),
				p.account,
				p.pool,
				p.asset,
				p.amount,
				p.supply,
				p.deadline,
			],
		),
	)
	const structHash = keccak256(
		encodeAbiParameters(parseAbiParameters('bytes32, bytes32, bytes32, uint256'), [
			keccak256(stringToHex(moveType)),
			paramsHash,
			auth.policyHash,
			auth.nonce,
		]),
	)
	return keccak256(concatHex(['0x1901', domainSeparatorBySpec(), structHash]))
}

const domainSeparatorBySpec = (): Hex =>
	keccak256(
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

describe('the domain', () => {
	/**
	 * `AccountAuth.domainSeparator` is what the account itself hashes, and it takes the name and
	 * version as constants rather than as arguments. If this drifts, a statement signed here is
	 * about a domain no `HelicoAccount` has, and the only symptom is a signature that recovers to
	 * the wrong address.
	 *
	 *   cast keccak "$(cast abi-encode 'f(bytes32,bytes32,bytes32,uint256,address)' \
	 *     $(cast keccak "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)") \
	 *     $(cast keccak "HelicoAccount") $(cast keccak "1") 42161 0x1111…1111)"
	 */
	test('is the account’s own, pinned to a separator produced by cast', () => {
		expect(domainSeparatorBySpec()).toBe(
			'0xde1cbd484ff08005bbf1464e9062756b61ee599ffdc8718e190cb28b8cd10072',
		)
	})
})

describe('idleMoveDigest', () => {
	test('equals the EIP-712 digest computed by hand from the type strings', () => {
		expect(idleMoveDigest(domain, auth)).toBe(digestBySpec())
	})

	test('changes with the nonce, the policy hash, the params, and the domain', () => {
		const d = idleMoveDigest(domain, auth)
		expect(idleMoveDigest(domain, { ...auth, nonce: 2n })).not.toBe(d)
		expect(idleMoveDigest(domain, { ...auth, policyHash: `0x${'ab'.repeat(32)}` })).not.toBe(d)
		expect(idleMoveDigest(domain, { ...auth, params: { ...auth.params, amount: 1n } })).not.toBe(d)
		// The direction is part of the statement: a supply and a withdrawal of the same size are
		// opposite instructions, and one signature must never authorise both.
		expect(idleMoveDigest(domain, { ...auth, params: { ...auth.params, supply: false } })).not.toBe(
			d,
		)
		expect(idleMoveDigest({ ...domain, chainId: 1 }, auth)).not.toBe(d)
		expect(idleMoveDigest({ ...domain, verifyingContract: pool }, auth)).not.toBe(d)
	})
})

describe('signIdleMove', () => {
	test('signs deterministically with the agent key and recovers to its address', async () => {
		const a = await signIdleMove(key, domain, auth)
		const b = await signIdleMove(key, domain, auth)
		expect(a.signer).toBe(keyAddress)
		expect(a.signature).toBe(b.signature)
		expect(a.signature).toHaveLength(2 + 65 * 2)
		expect(await recoverIdleMoveSigner(domain, auth, a.signature)).toBe(keyAddress)
		// A signature over a different nonce does not recover to the agent for this one.
		const other = await signIdleMove(key, domain, { ...auth, nonce: 2n })
		expect(await recoverIdleMoveSigner(domain, auth, other.signature)).not.toBe(keyAddress)
	})
})

describe('encodeAuthorisation', () => {
	test('round-trips as (IdleMoveParams, bytes32, uint256, bytes)', async () => {
		const { signature } = await signIdleMove(key, domain, auth)
		const [p, hash, nonce, sig] = decodeAbiParameters(
			[idleMoveParamsAbi, { type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes' }],
			encodeAuthorisation(auth, signature),
		)
		expect(p).toEqual(auth.params)
		expect(hash).toBe(auth.policyHash)
		expect(nonce).toBe(1n)
		expect(sig).toBe(signature)
	})
})

describe('encodeIdleMove', () => {
	// cast calldata "supplyIdle(address,address,uint256)" 0x794a…14aD 0xaf88…5831 800000000
	test('builds the account call the agent makes, pinned to calldata produced by cast', () => {
		expect(encodeIdleMove(auth.params)).toEqual({
			to: account,
			data: '0x853112a5000000000000000000000000794a61358d6845594f94dc1db02a252b5b4814ad000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e5831000000000000000000000000000000000000000000000000000000002faf0800',
		})
	})

	test('the direction picks the function, and nothing else about the call changes', () => {
		const supply = encodeIdleMove(auth.params)
		const withdraw = encodeIdleMove({ ...auth.params, supply: false })
		expect(withdraw.to).toBe(supply.to)
		expect(withdraw.data.slice(0, 10)).toBe('0x20f623a0')
		expect(withdraw.data.slice(10)).toBe(supply.data.slice(10))
	})

	/**
	 * The security argument, as an assertion rather than as a sentence: neither call carries a
	 * recipient, so the three words after the selector are the pool, the asset, and the amount,
	 * and there is nowhere in the calldata for a relayer to write an address of their own.
	 */
	test('carries no recipient: three arguments, none of them a destination', () => {
		const { data } = encodeIdleMove(auth.params)
		expect(data.length).toBe(2 + 8 + 3 * 64)
		expect(data.slice(10).match(/.{64}/g)).toEqual([
			`${'0'.repeat(24)}${pool.slice(2).toLowerCase()}`,
			`${'0'.repeat(24)}${usdc.slice(2).toLowerCase()}`,
			800_000_000n.toString(16).padStart(64, '0'),
		])
	})
})
