#!/usr/bin/env bun
/**
 * Ship a mandate from TypeScript, against the contracts that are actually deployed, and fill it.
 *
 * The mandate half of the 1inch track had never left Solidity. `AccountIsTheMaker.t.sol` proves
 * the flow, but a Foundry test builds its calldata with `abi.encodeWithSignature` inside the EVM;
 * nothing outside it could encode a `SwapMandate`. This is the same flow with every byte built by
 * `@helico/plugin-1inch`, so what passes here is what a browser would send.
 *
 * The check that matters is the first one. Aqua files a position under `keccak256` of the raw
 * bytes shipped, and the app recomputes that hash from the struct it is handed — so an encoding
 * that is wrong by one field does not revert. It ships successfully, files under a hash nobody
 * looks up, and every later call answers for a mandate that does not exist. So the bytes are held
 * against the deployed contract's own `mandateHash` before anything else runs.
 *
 *     anvil --fork-url https://arb1.arbitrum.io/rpc --port 8549 --silent &
 *     bun scripts/check-mandate.ts
 *
 * A fork, because shipping writes to Aqua and filling moves real tokens. No key of Helico's is
 * used, nothing is deployed to a real chain, and `RPC_URL` overrides the endpoint.
 */
import {
	ARBITRUM_ONE,
	aquaAddress,
	MANDATE_SWAP_ABI,
	mandateHash,
	mandateSetupCalls,
	mandateSwapAddress,
	ReceiptKind,
	type SwapMandate,
} from '@helico/plugin-1inch'
import { createPublicClient, createWalletClient, http, parseAbi, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrum } from 'viem/chains'

const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8549'

const FACTORY = '0x01CC7d9FE8da79B61bcc5d3f7e3f0433DCE7E081' as const
const AAVE_POOL = '0x794a61358D6845594F94dc1DB02A252b5b4814aD' as const
const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' as const
const WETH = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' as const
const AUSDC = '0x724dc807b04555b71ed48a6896b6F41593b8C637' as const
// Holders on Arbitrum One, used through anvil's impersonation. Real transfers rather than balances
// written into storage: an account that could never have been paid proves nothing about one that
// can. `AUSDC` is Aave's own USDC reserve, which is also where the account's `working` side lives.
const USDC_WHALE = AUSDC

// anvil's first account. Public, and holds nothing anywhere real.
const owner = privateKeyToAccount(
	'0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
)

const pub = createPublicClient({ chain: arbitrum, transport: http(RPC) })
const wal = createWalletClient({ account: owner, chain: arbitrum, transport: http(RPC) })

const erc20 = parseAbi([
	'function balanceOf(address) view returns (uint256)',
	'function transfer(address to, uint256 value) returns (bool)',
	'function deposit() payable',
])
const factoryAbi = parseAbi([
	'function accountFor(address owner) view returns (address)',
	'function isOpen(address owner) view returns (bool)',
	'function open(address owner) returns (address)',
])
const accountAbi = parseAbi([
	'function permitVenue(address pool, bool allowed)',
	'function supplyIdle(address pool, address asset, uint256 amount)',
	'function executeBatch((address target, uint256 value, bytes data)[] calls) returns (bytes[])',
])
const aquaAbi = parseAbi([
	'function rawBalances(address maker, address app, bytes32 strategyHash, address token) view returns (uint248, uint8)',
])
const takerAbi = parseAbi([
	'function approveAqua(address token)',
	'function swap(address app, (address,address,address,uint256,uint256,uint256,uint64,address,bytes32,(address,address,address,uint8)[]) mandate, bool zeroForOne, uint256 amountIn, uint256 amountOutMin, address to) returns (uint256)',
])

const failures: string[] = []
const check = (name: string, ok: boolean, detail = '') => {
	console.log(`${ok ? '  ok  ' : 'FAIL  '}${name}${detail ? `  — ${detail}` : ''}`)
	if (!ok) failures.push(name)
}

const rpc = (method: string, params: unknown[]) =>
	fetch(RPC, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
	}).then((r) => r.json())

/** Move a token out of a real holder's balance, through anvil's impersonation. */
async function fund(token: `0x${string}`, from: `0x${string}`, to: `0x${string}`, value: bigint) {
	await rpc('anvil_impersonateAccount', [from])
	await rpc('anvil_setBalance', [from, toHex(10n ** 18n)])
	const impersonated = createWalletClient({ account: from, chain: arbitrum, transport: http(RPC) })
	const hash = await impersonated.writeContract({
		abi: erc20,
		address: token,
		args: [to, value],
		functionName: 'transfer',
	})
	await pub.waitForTransactionReceipt({ hash })
	await rpc('anvil_stopImpersonatingAccount', [from])
}

const send = async (request: Parameters<typeof wal.writeContract>[0]) => {
	// biome-ignore lint/suspicious/noExplicitAny: viem's write union is not worth threading here
	const hash = await wal.writeContract(request as any)
	return pub.waitForTransactionReceipt({ hash })
}

/** A receipt's address, or a failure that says which deployment produced no contract. */
function deployed(receipt: { contractAddress: `0x${string}` | null }): `0x${string}` {
	if (!receipt.contractAddress) throw new Error('a deployment produced no contract address')
	return receipt.contractAddress
}

const chainId = await pub.getChainId()
if (chainId !== ARBITRUM_ONE) {
	console.error(`Expected a fork of Arbitrum One (42161), got ${chainId}. Is anvil running?`)
	process.exit(1)
}

const APP = mandateSwapAddress(ARBITRUM_ONE)
const AQUA = aquaAddress(ARBITRUM_ONE)

console.log(`\nAqua ${AQUA}\napp  ${APP}\n`)

const deployedCode = (await pub.getCode({ address: APP })) ?? '0x'
check('the app is deployed, so the rest of this means something', deployedCode.length > 2, APP)

// And it is the app this package can actually talk to, which the address alone does not say.
//
// The one this replaced could not have taken a mandate at all: `ReceiptKind` widened `Venue` on 9
// September, and the old app answered `mandateHash` at `0xbeb513da` while today's struct hashes to
// `0x5344635d`. A mandate sent there would not have reverted — it would have missed the function,
// which is the failure that looks like nothing at all.
//
// **Asked rather than read out of the bytecode.** This grepped the deployed code for the selector
// until 10 September, when the apps went behind proxies and the check broke on a deployment that
// was correct: a proxy is a few hundred bytes of delegatecall and carries no selectors at all. The
// implementation had it and the address that matters did not, so the guard failed on the one thing
// it was written to protect.
//
// Calling it is the better test anyway. A selector present in bytecode is not a selector that can
// be reached; an answer is.
// A throwaway mandate: nothing is shipped with it and none of its fields matter. It exists only
// so the call has an argument of today's shape.
const PROBE: SwapMandate = {
	maker: '0x0000000000000000000000000000000000000001',
	token0: '0x0000000000000000000000000000000000000002',
	token1: '0x0000000000000000000000000000000000000003',
	feeBps: 30n,
	maxOut0: 0n,
	maxOut1: 0n,
	expiry: 0n,
	agent: '0x0000000000000000000000000000000000000004',
	salt: toHex(0, { size: 32 }),
	venues: [],
}

let answersTodaysMandate = false
try {
	await pub.readContract({
		address: APP,
		abi: MANDATE_SWAP_ABI,
		functionName: 'mandateHash',
		args: [PROBE],
	})
	answersTodaysMandate = true
} catch {
	answersTodaysMandate = false
}
check(
	'and it answers the mandate this package encodes',
	answersTodaysMandate,
	'mandateHash(SwapMandate) → 0x5344635d, called through whatever is at that address',
)
if (!answersTodaysMandate) {
	console.error('\nThat address cannot read a mandate this package encodes. Stopping.')
	process.exit(1)
}

// The live app, not a fresh one. Until 10 September this script deployed its own copy, because the
// deployed pair predated the struct — running against a contract nobody uses proved the encoder
// and nothing about the deployment.
const LIVE_APP = APP

// ---------------------------------------------------------------------------------------------
// 1. The bytes, held against the contract that will read them.
// ---------------------------------------------------------------------------------------------

// Deployed first, because the mandate names its taker and Aqua will not let the rules be edited
// afterwards: rotating the agent costs a dock and a re-ship.
const artifact = await Bun.file('contracts/out/MandateTakers.sol/PayingTaker.json').json()
const takerHash = await wal.deployContract({
	// The artifact's own ABI, because the trimmed one above has no constructor to encode against.
	abi: artifact.abi,
	args: [AQUA],
	bytecode: artifact.bytecode.object as `0x${string}`,
})
const TAKER = deployed(await pub.waitForTransactionReceipt({ hash: takerHash }))

const account = await pub.readContract({
	abi: factoryAbi,
	address: FACTORY,
	args: [owner.address],
	functionName: 'accountFor',
})

const mandate: SwapMandate = {
	maker: account,
	token0: USDC,
	token1: WETH,
	feeBps: 30n,
	maxOut0: 2_000_000000n,
	maxOut1: 10n ** 18n,
	expiry: BigInt(Math.floor(Date.now() / 1000) + 86_400),
	agent: TAKER,
	salt: `0x${'a1'.repeat(32)}`,
	// The Aave position the fill may be paid out of. `receipt1` is zero because only the USDC side
	// is lent; a fill taking WETH out comes from the wallet.
	venues: [
		{
			pool: AAVE_POOL,
			receipt0: AUSDC,
			receipt1: '0x0000000000000000000000000000000000000000',
			kind: ReceiptKind.Rebasing,
		},
	],
}

const theirs = await pub.readContract({
	abi: MANDATE_SWAP_ABI,
	address: LIVE_APP,
	args: [mandate],
	functionName: 'mandateHash',
})
const ours = mandateHash(mandate)
check(
	'the bytes this package encodes hash to what the deployed app says they do',
	theirs === ours,
	`${ours.slice(0, 18)}…`,
)
if (theirs !== ours) {
	console.error('\nNothing below can be trusted with the wrong bytes. Stopping.')
	process.exit(1)
}

// ---------------------------------------------------------------------------------------------
// 2. An account, funded, with part of its capital earning.
// ---------------------------------------------------------------------------------------------

const RESERVE_USDC = 3_000_000000n
const RESERVE_WETH = 10n ** 18n
const LENT = 2_000_000000n

await send({ abi: factoryAbi, address: FACTORY, args: [owner.address], functionName: 'open' })
check(
	'the factory opened the account this mandate names as its maker',
	await pub.readContract({
		abi: factoryAbi,
		address: FACTORY,
		args: [owner.address],
		functionName: 'isOpen',
	}),
	account,
)

await fund(USDC, USDC_WHALE, account, RESERVE_USDC)
// WETH is minted rather than moved: it is its own holder, so impersonating it to transfer out of
// its own balance would move the pool's collateral rather than someone's tokens.
await rpc('anvil_setBalance', [owner.address, toHex(20n * 10n ** 18n)])
await send({ abi: erc20, address: WETH, functionName: 'deposit', value: RESERVE_WETH })
await send({ abi: erc20, address: WETH, args: [account, RESERVE_WETH], functionName: 'transfer' })

await send({
	abi: accountAbi,
	address: account,
	args: [AAVE_POOL, true],
	functionName: 'permitVenue',
})
await send({
	abi: accountAbi,
	address: account,
	args: [AAVE_POOL, USDC, LENT],
	functionName: 'supplyIdle',
})
const working = await pub.readContract({
	abi: erc20,
	address: AUSDC,
	args: [account],
	functionName: 'balanceOf',
})
// Aave mints the receipt a couple of units light on this fork. The claim is that the supply
// landed, not that it landed to the wei, so the tolerance is named rather than the assertion bent.
check(
	'two thirds of the account’s USDC is earning in Aave v3',
	LENT - working <= 10n,
	`${working} aUSDC`,
)

// ---------------------------------------------------------------------------------------------
// 3. Ship it, with every byte built by the plugin.
// ---------------------------------------------------------------------------------------------

const tokens: `0x${string}`[] = [USDC, WETH, AUSDC]
const amounts = [RESERVE_USDC, RESERVE_WETH, LENT]
const calls = mandateSetupCalls(ARBITRUM_ONE, LIVE_APP, mandate, tokens, amounts)
check('the setup is three approvals and a ship', calls.length === 4)

const usdcBefore = await pub.readContract({
	abi: erc20,
	address: USDC,
	args: [account],
	functionName: 'balanceOf',
})

await send({
	abi: accountAbi,
	address: account,
	args: [calls.map((c) => ({ target: c.to, value: 0n, data: c.data }))],
	functionName: 'executeBatch',
})

const [ledgerUsdc] = await pub.readContract({
	abi: aquaAbi,
	address: AQUA,
	args: [account, LIVE_APP, ours, USDC],
	functionName: 'rawBalances',
})
const [ledgerWeth] = await pub.readContract({
	abi: aquaAbi,
	address: AQUA,
	args: [account, LIVE_APP, ours, WETH],
	functionName: 'rawBalances',
})
check('Aqua files the mandate under the account, not the owner', ledgerUsdc === RESERVE_USDC)
check('and the WETH side is there too', ledgerWeth === RESERVE_WETH)
check(
	'shipping moved no tokens — it wrote a ledger entry',
	(await pub.readContract({
		abi: erc20,
		address: USDC,
		args: [account],
		functionName: 'balanceOf',
	})) === usdcBefore,
	`${usdcBefore} USDC, unchanged`,
)

// ---------------------------------------------------------------------------------------------
// 4. Quote it, then fill it.
// ---------------------------------------------------------------------------------------------

const AMOUNT_IN = 10n ** 17n
const quoted = await pub.readContract({
	abi: MANDATE_SWAP_ABI,
	address: LIVE_APP,
	args: [mandate, false, AMOUNT_IN],
	functionName: 'quoteExactIn',
})
check('the shipped mandate prices a swap', quoted > 0n, `0.1 WETH → ${quoted} USDC`)

await send({ abi: erc20, address: WETH, functionName: 'deposit', value: AMOUNT_IN })
await send({ abi: erc20, address: WETH, args: [TAKER, AMOUNT_IN], functionName: 'transfer' })
await send({ abi: takerAbi, address: TAKER, args: [WETH], functionName: 'approveAqua' })

const idleBefore = await pub.readContract({
	abi: erc20,
	address: USDC,
	args: [account],
	functionName: 'balanceOf',
})
const workingBefore = await pub.readContract({
	abi: erc20,
	address: AUSDC,
	args: [account],
	functionName: 'balanceOf',
})

await send({
	abi: takerAbi,
	address: TAKER,
	args: [
		LIVE_APP,
		[
			mandate.maker,
			mandate.token0,
			mandate.token1,
			mandate.feeBps,
			mandate.maxOut0,
			mandate.maxOut1,
			mandate.expiry,
			mandate.agent,
			mandate.salt,
			mandate.venues.map((v) => [v.pool, v.receipt0, v.receipt1, v.kind]),
		],
		false,
		AMOUNT_IN,
		0n,
		owner.address,
		// biome-ignore lint/suspicious/noExplicitAny: the mandate tuple is positional in this ABI
	] as any,
	functionName: 'swap',
})

const takerUsdc = await pub.readContract({
	abi: erc20,
	address: USDC,
	args: [owner.address],
	functionName: 'balanceOf',
})
const idleAfter = await pub.readContract({
	abi: erc20,
	address: USDC,
	args: [account],
	functionName: 'balanceOf',
})
const workingAfter = await pub.readContract({
	abi: erc20,
	address: AUSDC,
	args: [account],
	functionName: 'balanceOf',
})
const accountWeth = await pub.readContract({
	abi: erc20,
	address: WETH,
	args: [account],
	functionName: 'balanceOf',
})

check('the taker was paid the USDC it was quoted', takerUsdc === quoted, `${takerUsdc} USDC`)
check('the maker’s account received the WETH', accountWeth === RESERVE_WETH + AMOUNT_IN)
check(
	'the wallet is spent before the lending market',
	idleAfter < idleBefore,
	`idle ${idleBefore} → ${idleAfter}`,
)
check(
	'and the Aave position was left alone, because the wallet covered it',
	workingAfter >= workingBefore,
	`working ${workingBefore} → ${workingAfter}`,
)

// ---------------------------------------------------------------------------------------------
// 5. A fill the wallet cannot cover, which is the sentence the product is built on.
// ---------------------------------------------------------------------------------------------

// The venue in the mandate above is not decoration, and a fill the wallet covers does not prove
// it. This one asks for more USDC than the account holds idle, so paying it requires unwinding
// part of the Aave position — through `AQUA.pull` on the receipt token, which is why aUSDC was
// shipped alongside the pair.
const BIG_IN = 2n * 10n ** 18n
const bigQuote = await pub.readContract({
	abi: MANDATE_SWAP_ABI,
	address: LIVE_APP,
	args: [mandate, false, BIG_IN],
	functionName: 'quoteExactIn',
})
check(
	'the next fill is larger than the wallet holds idle',
	bigQuote > idleAfter,
	`${bigQuote} wanted, ${idleAfter} idle`,
)

await send({ abi: erc20, address: WETH, functionName: 'deposit', value: BIG_IN })
await send({ abi: erc20, address: WETH, args: [TAKER, BIG_IN], functionName: 'transfer' })
await send({
	abi: takerAbi,
	address: TAKER,
	args: [
		LIVE_APP,
		[
			mandate.maker,
			mandate.token0,
			mandate.token1,
			mandate.feeBps,
			mandate.maxOut0,
			mandate.maxOut1,
			mandate.expiry,
			mandate.agent,
			mandate.salt,
			mandate.venues.map((v) => [v.pool, v.receipt0, v.receipt1, v.kind]),
		],
		false,
		BIG_IN,
		0n,
		owner.address,
		// biome-ignore lint/suspicious/noExplicitAny: the mandate tuple is positional in this ABI
	] as any,
	functionName: 'swap',
})

const workingUnwound = await pub.readContract({
	abi: erc20,
	address: AUSDC,
	args: [account],
	functionName: 'balanceOf',
})
const paidTotal = await pub.readContract({
	abi: erc20,
	address: USDC,
	args: [owner.address],
	functionName: 'balanceOf',
})
check(
	'the taker was paid what it was quoted again',
	paidTotal === takerUsdc + bigQuote,
	`${bigQuote} more USDC`,
)
// The claim of the whole product: the capital that earns is the capital the mandate spends.
check(
	'the fill was paid out of the Aave position, because the wallet could not cover it',
	workingUnwound < workingAfter,
	`working ${workingAfter} → ${workingUnwound}`,
)

console.log(
	failures.length === 0
		? '\na mandate was encoded, shipped from an account, quoted, filled, and paid out of Aave — all of it from TypeScript'
		: `\n${failures.length} failed: ${failures.join('; ')}`,
)
process.exit(failures.length === 0 ? 0 : 1)
