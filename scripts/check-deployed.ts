#!/usr/bin/env bun
/**
 * Prove the **deployed set** works, from TypeScript, against the addresses that are actually live.
 *
 * Renamed from `check-mandate.ts` on 10 September, when it stopped being about the mandate. Most
 * fork tests in `contracts/test` deploy a fresh copy of the source and prove the *code* against
 * real counterparties; only this proves the *deployment*. The difference is the one a judge asks
 * about: whether what is being shown is what is on chain.
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
 *     bun scripts/check-deployed.ts
 *
 * **A fresh anvil each time.** The fork keeps state between runs, so a second run against the same
 * instance opens an account that already exists and quotes against reserves the first run moved.
 * The failures then look like the script rather than the fixture, which cost half an hour once.
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
// The rest of the deployed set. Written here rather than imported so a wrong address in the
// package cannot make this script agree with it — the point is to check the deployment, and a
// check that reads its expectation from the thing it is checking is not one.
const ORACLE_BOARD = '0xe8515af92442A5CDa67D1F32D1c8a987ba7e7d39' as const
const COMPOUND_VENUE = '0x1eC57cE1DdfdC7a4EbF4F54Aedee19ab73fcBB2E' as const
const MORPHO_VENUE = '0xBBa798A61f0D7D1AE51466Fd4045Cd2Ea25c9A29' as const
const ETH_USD_FEED = '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612' as const
const COMET = '0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf' as const
const MORPHO_VAULT = '0x5c0C306Aaa9F877de636f4d5822cA9F2E81563BA' as const
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
const approveAbi = parseAbi(['function approve(address spender, uint256 value) returns (bool)'])
const venueAbi = parseAbi([
	'function UNDERLYING_ASSET_ADDRESS() view returns (address)',
	'function getReserveAToken(address asset) view returns (address)',
	'function getVirtualUnderlyingBalance(address asset) view returns (uint128)',
	'function symbol() view returns (string)',
	'function balanceOf(address) view returns (uint256)',
	'function previewRedeem(uint256 shares) view returns (uint256)',
	'function totalAssets() view returns (uint256)',
	'function totalSupply() view returns (uint256)',
	'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referral)',
	'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
	'function approve(address spender, uint256 value) returns (bool)',
	'function poke()',
	// Declared so viem can name it. Without the error in the ABI a revert comes back as raw
	// data, and a check matching on the name reports 'refused for another reason' about the
	// exact refusal it was written to find.
	'error DepositMintsNothing(uint256 amount)',
])
const reserveDataAbi = parseAbi([
	'function getReserveData(address asset) view returns ((uint256,uint128,uint128,uint128,uint128,uint128,uint40,uint16,address,address,address,address,uint128,uint128,uint128))',
])
const boardAbi = parseAbi([
	'function AQUA() view returns (address)',
	'function UPGRADER() view returns (address)',
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

// ── the rest of the deployed set ─────────────────────────────────────────────
//
// Everything above exercises two live addresses: the factory and the mandate swap. The other four
// contracts were only ever proven as *source* — `contracts/test` deploys a fresh copy of each and
// runs it against real Aqua, real Aave, real Comet, a real Morpho vault. That proves the code and
// says nothing about the bytecode at our addresses, which is the question worth answering out loud
// before a camera is pointed at any of it.

console.log('\n── the rest of the deployed set ──\n')

// The two proxies answer through delegatecall, so a wrong implementation slot shows up here as a
// call that reverts rather than as a wrong number.
const boardAqua = await pub.readContract({
	abi: boardAbi,
	address: ORACLE_BOARD,
	functionName: 'AQUA',
})
check(
	'the oracle board is live and points at the same Aqua',
	boardAqua.toLowerCase() === AQUA.toLowerCase(),
	ORACLE_BOARD,
)
const boardUpgrader = await pub.readContract({
	abi: boardAbi,
	address: ORACLE_BOARD,
	functionName: 'UPGRADER',
})
check(
	'and it answers through its proxy, which is what makes it upgradeable',
	boardUpgrader !== '0x0000000000000000000000000000000000000000',
	`UPGRADER ${boardUpgrader}`,
)

// The feed the board quotes from. A board pricing off a stale feed is a board being taken from,
// and the contract refuses one past its `maxStaleness` — so this is not redundant with the
// contract's own check, it is the thing that says *today* whether a recording can go ahead.
const feedAbi = parseAbi([
	'function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)',
	'function description() view returns (string)',
])
const [, answer, , updatedAt] = await pub.readContract({
	abi: feedAbi,
	address: ETH_USD_FEED,
	functionName: 'latestRoundData',
})
const block = await pub.getBlock()
const age = Number(block.timestamp - updatedAt)
check(
	'the ETH/USD feed the board quotes from is answering',
	answer > 0n,
	`${Number(answer) / 1e8} USD`,
)
check('  and it is not stale', age < 3600, `${age}s since the last round`)

// Each venue is asked the three things `_requireReceiptFor` and the cover search depend on. A
// venue that answers the first two and not the third is refused at the first fill rather than at
// deploy, which is the failure this catches early.
for (const [name, venue, symbol] of [
	['Compound', COMPOUND_VENUE, 'hcUSDC'],
	['Morpho', MORPHO_VENUE, 'hmUSDC'],
] as const) {
	const [sym, underlying, receipt] = await Promise.all([
		pub.readContract({ abi: venueAbi, address: venue, functionName: 'symbol' }),
		pub.readContract({ abi: venueAbi, address: venue, functionName: 'UNDERLYING_ASSET_ADDRESS' }),
		pub.readContract({
			abi: venueAbi,
			address: venue,
			functionName: 'getReserveAToken',
			args: [USDC],
		}),
	])
	check(`the ${name} venue is live`, sym === symbol, `${venue} → ${sym}`)
	check(
		`  and it answers Aave's spelling, which both Aqua apps ask for`,
		underlying.toLowerCase() === USDC.toLowerCase(),
		'UNDERLYING_ASSET_ADDRESS() → USDC',
	)
	check(
		`  and names itself as its own receipt, which is what lets _cover burn without an approval`,
		receipt.toLowerCase() === venue.toLowerCase(),
		'getReserveAToken(USDC) → itself',
	)
}

// **The check that tells one generation from another**, and it took three attempts.
//
// **It runs inside a snapshot, and there is no order that works without one.** The attack needs the
// attacker to hold exactly one share, so it must run before anything parks capital — a wei only
// mints one share while the venue is empty. But it also *donates* into the venue, which leaves
// `totalAssets` a hundred thousand times `totalSupply`, and the parking step's own hundred USDC
// then rounds to zero and is refused by the same guard.
//
// Both orderings crash, and both crashes read as the script being broken rather than as a check
// with side effects. `evm_snapshot` and `evm_revert` are the answer: the venue is put back exactly
// as it was found, and everything after this block sees a chain the attack never touched.
//
// The first attempt was pointing `COMPOUND_VENUE` at the venue it superseded and watching every
// check above pass: the old address holds a real, working `CompoundVenue` answering the interface
// exactly as the new one does. The script proved "a venue is here" and not "our venue is here",
// and this repository has replaced that contract three times in two days.
//
// The second attempt was worse, because it looked like it worked. It called `supply` and treated
// any revert as a refusal — but the attacker had never approved **USDC** to the venue, so the call
// reverted on allowance in *both* generations and the check reported a pass. A check that passes
// for a reason other than the one it names is the failure mode this repository keeps writing down.
//
// What actually separates them is behaviour under a specific state: donate into a fresh venue and
// the superseded pair mints **zero shares** for a real deposit while returning happily. So the
// donation is set up, the deposit is attempted, and the error is matched by name rather than by
// the presence of a revert.
console.log('')
const snapshot = (await rpc('evm_snapshot', [])).result as string
const attacker = privateKeyToAccount(
	'0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
)
const atk = createWalletClient({ account: attacker, chain: arbitrum, transport: http(RPC) })
await rpc('anvil_setBalance', [attacker.address, toHex(10n ** 18n)])
// Enough for the donation and the victim's deposit, and no more: the whale is Aave's own
// USDC reserve and a request it cannot meet fails as `transfer amount exceeds balance`.
await fund(USDC, USDC_WHALE, attacker.address, 25_000_000000n)

let venue_: `0x${string}` = COMPOUND_VENUE
const cometAbi = parseAbi(['function supplyTo(address dst, address asset, uint256 amount)'])
const vaultAbi = parseAbi(['function deposit(uint256 assets, address receiver) returns (uint256)'])
const approveUsdc = (spender: `0x${string}`) =>
	atk
		.writeContract({
			abi: approveAbi,
			address: USDC,
			args: [spender, 2n ** 255n],
			functionName: 'approve',
		})
		.then((hash) => pub.waitForTransactionReceipt({ hash }))

for (const [name, venue, donate] of [
	[
		'Compound',
		COMPOUND_VENUE,
		async () => {
			await approveUsdc(COMET)
			await atk
				.writeContract({
					abi: cometAbi,
					address: COMET,
					args: [venue_, USDC, 10_000_000000n],
					functionName: 'supplyTo',
				})
				.then((hash) => pub.waitForTransactionReceipt({ hash }))
		},
	],
	[
		'Morpho',
		MORPHO_VENUE,
		async () => {
			await approveUsdc(MORPHO_VAULT)
			await atk
				.writeContract({
					abi: vaultAbi,
					address: MORPHO_VAULT,
					args: [10_000_000000n, venue_],
					functionName: 'deposit',
				})
				.then((hash) => pub.waitForTransactionReceipt({ hash }))
		},
	],
] as const) {
	venue_ = venue
	// One wei in first, so the pool has exactly one share to be diluted against.
	await approveUsdc(venue)
	await atk
		.writeContract({
			abi: venueAbi,
			address: venue,
			args: [USDC, 1n, attacker.address, 0],
			functionName: 'supply',
		})
		.then((hash) => pub.waitForTransactionReceipt({ hash }))
	await donate()

	let refusedByName = false
	let saw = 'it accepted the deposit — this is a superseded venue'
	try {
		await pub.simulateContract({
			abi: venueAbi,
			account: attacker.address,
			address: venue,
			args: [USDC, 1_000_000000n, attacker.address, 0],
			functionName: 'supply',
		})
	} catch (e) {
		const text = String(e)
		refusedByName = text.includes('DepositMintsNothing')
		saw = refusedByName
			? 'DepositMintsNothing'
			: `refused, but for another reason: ${text.slice(0, 60)}`
	}
	check(
		`the ${name} venue here is the generation that refuses a deposit worth zero shares`,
		refusedByName,
		saw,
	)
}

await rpc('evm_revert', [snapshot])
check(
	'and the chain was put back, so the donation cannot poison what runs next',
	((await pub.readContract({
		abi: venueAbi,
		address: COMPOUND_VENUE,
		functionName: 'totalAssets',
	})) as bigint) === 0n,
	'CompoundVenue.totalAssets() back to 0',
)

// The claim the whole venue exercise was for, made against the deployed addresses rather than
// fresh copies: three markets, three different rate sources, one comparable unit. A scaling
// mistake in any of the three conversions would not be a bad price — it would win or lose every
// comparison by orders of magnitude.
const rates: Record<string, bigint> = {}
for (const [name, pool] of [
	['Aave', AAVE_POOL],
	['Compound', COMPOUND_VENUE],
	['Morpho', MORPHO_VENUE],
] as const) {
	const data = await pub.readContract({
		abi: reserveDataAbi,
		address: pool,
		args: [USDC],
		functionName: 'getReserveData',
	})
	rates[name] = data[2]
}
// Morpho's is measured rather than published, so a venue nobody has touched reports zero. That is
// correct and invisible to an optimiser, so the script pokes it exactly as the agent would.
if (rates.Morpho === 0n) {
	await send({ abi: venueAbi, address: MORPHO_VENUE, functionName: 'poke' })
	const again = await pub.readContract({
		abi: reserveDataAbi,
		address: MORPHO_VENUE,
		args: [USDC],
		functionName: 'getReserveData',
	})
	rates.Morpho = again[2]
}
const bps = (ray: bigint) => Number(ray / 10n ** 23n)
for (const [name, ray] of Object.entries(rates)) {
	check(
		`${name} reports a rate in Aave's ray, not its own units`,
		ray > 10n ** 23n && ray < 5n * 10n ** 26n,
		`${bps(ray)} bps`,
	)
}

// One account, three protocols, and none of them known to the account by name. This is the line
// the product rests on, and until now it was only ever run against venues deployed inside a test.
console.log('')
for (const [name, venue] of [
	['Aave', AAVE_POOL],
	['Compound', COMPOUND_VENUE],
	['Morpho', MORPHO_VENUE],
] as const) {
	await send({
		abi: accountAbi,
		address: account,
		args: [venue, true],
		functionName: 'permitVenue',
	})
	check(`the owner permitted the live ${name} venue`, true, venue)
}

const PARK = 100_000000n
await fund(USDC, USDC_WHALE, account, 3n * PARK)
const walletBeforeParking = await pub.readContract({
	abi: erc20,
	address: USDC,
	args: [account],
	functionName: 'balanceOf',
})
for (const [name, venue] of [
	['Aave', AAVE_POOL],
	['Compound', COMPOUND_VENUE],
	['Morpho', MORPHO_VENUE],
] as const) {
	await send({
		abi: accountAbi,
		address: account,
		args: [venue, USDC, PARK],
		functionName: 'supplyIdle',
	})
	const held =
		venue === AAVE_POOL
			? await pub.readContract({
					abi: erc20,
					address: AUSDC,
					args: [account],
					functionName: 'balanceOf',
				})
			: await pub.readContract({
					abi: venueAbi,
					address: venue,
					args: [
						await pub.readContract({
							abi: venueAbi,
							address: venue,
							args: [account],
							functionName: 'balanceOf',
						}),
					],
					functionName: 'previewRedeem',
				})
	check(
		`  and the agent parked capital in the live ${name} venue`,
		held >= PARK - 10n,
		`${held} USDC of position`,
	)
}

const walletAfterParking = await pub.readContract({
	abi: erc20,
	address: USDC,
	args: [account],
	functionName: 'balanceOf',
})
check(
	'three protocols, one account, and the wallet paid for all three',
	walletBeforeParking - walletAfterParking === 3n * PARK,
	`idle ${walletBeforeParking} → ${walletAfterParking}`,
)

console.log(
	failures.length === 0
		? '\nevery deployed contract answered at its own address: a mandate encoded, shipped, quoted, filled and paid out of Aave, and one account reaching three protocols through the live venues'
		: `\n${failures.length} failed: ${failures.join('; ')}`,
)
process.exit(failures.length === 0 ? 0 : 1)
