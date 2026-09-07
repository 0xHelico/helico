import { type Address, parseAbi } from 'viem'

/**
 * `HelicoAccount` as the enclave sees it: the four values it reads before deciding, and the two
 * calls it is allowed to ask for.
 *
 * Deliberately not the whole contract. `execute`, `executeWithSignature`, `permitVenue`, and the
 * upgrade path are the owner's, and nothing the enclave produces can reach them — declaring them
 * here would suggest an authority the agent does not have. The pair that is declared is the
 * pair the account will accept from an agent, and neither takes a recipient.
 *
 * The errors matter as much as the functions: a refused move reaches a relayer as an unreadable
 * revert otherwise, when the account went to the trouble of naming the rule that was broken.
 */
export const accountAbi = parseAbi([
	'function owner() view returns (address)',
	'function agent() view returns (address)',
	'function permittedVenue(address pool) view returns (bool)',
	'function nonce() view returns (uint256)',
	'function supplyIdle(address pool, address asset, uint256 amount)',
	'function withdrawIdle(address pool, address asset, uint256 amount)',
	'event IdleCapitalMoved(address indexed pool, address indexed asset, uint256 amount, bool supplied)',
	'event AgentChanged(address indexed agent)',
	'event VenuePermitted(address indexed pool, bool allowed)',
	'error NotOwnerOrAgent(address caller)',
	'error VenueNotPermitted(address pool)',
])

/** What the account holds liquid. One function, because one is all the decision needs. */
export const erc20Abi = parseAbi(['function balanceOf(address account) view returns (uint256)'])

/**
 * The receipt token: how much of the position it represents, and which asset it is for.
 *
 * `UNDERLYING_ASSET_ADDRESS` is read for the reason `IReceiptToken` exists. A receipt for a
 * different asset makes an amount denominated in one token get spent out of a balance
 * denominated in another, and both numbers look plausible — the audit that found it had a
 * 3,216 USDC move consuming 32 BTC of receipt, because both are "3216440300" in their own units.
 */
export const receiptAbi = parseAbi([
	'function balanceOf(address account) view returns (uint256)',
	'function UNDERLYING_ASSET_ADDRESS() view returns (address)',
])

/**
 * The lending market, mirroring `ILendingVenue` — the same four functions the account itself
 * calls, so the enclave and the contract cannot end up describing different markets.
 *
 * `getVirtualUnderlyingBalance` is the number that binds a withdrawal on Aave v3, not the token
 * balance of the receipt contract; the two disagree by thousands of USDC on Arbitrum, and
 * sizing against the wrong one turns a clean hold into an arithmetic panic from inside the pool.
 */
export const lendingVenueAbi = parseAbi([
	'function getReserveAToken(address asset) view returns (address)',
	'function getVirtualUnderlyingBalance(address asset) view returns (uint128)',
	'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
	'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
])

/**
 * Aave v3's `getReserveData`, kept out of `lendingVenueAbi` because `ILendingVenue` deliberately
 * does not declare it: the account never calls this, only the enclave reads it, and only for the
 * rate the market is paying right now.
 *
 * Every field is static, so the struct and a flat list of fifteen returns encode to the same
 * bytes; the struct form is written out because that is what the contract declares. Pinned to a
 * real answer, checked 8 September 2026:
 *
 *     cast call 0x794a61358D6845594F94dc1DB02A252b5b4814aD \
 *       "getReserveData(address)((uint256),uint128,uint128,uint128,uint128,uint128,uint40,uint16,address,address,address,address,uint128,uint128,uint128)" \
 *       0xaf88d065e77c8cC2239327C5EDb3A432268e5831 --rpc-url https://arb1.arbitrum.io/rpc
 *
 * which returned `currentLiquidityRate = 27514566416591863466760475` — a ray, so 2.75% — and
 * `aTokenAddress = 0x724dc807b04555b71ed48a6896b6F41593b8C637`, the same aUSDC that
 * `getReserveAToken` names.
 */
export const reserveDataAbi = parseAbi([
	'function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))',
])

/**
 * The move the enclave decided on, as a tuple a report can carry and a contract can decode.
 *
 * `account` is in it although the calldata goes to the account, for the same reason
 * `RecenterParams.owner` was: a report written to a shared receiver has to name whose capital it
 * is about. `supply` is the direction rather than two tuples, so a hold and a move have the same
 * layout and the encoding never changes shape.
 */
export const idleMoveParamsAbi = {
	type: 'tuple',
	components: [
		{ name: 'account', type: 'address' },
		{ name: 'pool', type: 'address' },
		{ name: 'asset', type: 'address' },
		{ name: 'amount', type: 'uint256' },
		{ name: 'supply', type: 'bool' },
		{ name: 'deadline', type: 'uint256' },
	],
} as const

/** The move, mirrored field for field by `idleMoveParamsAbi`. */
export type IdleMoveParams = {
	account: Address
	pool: Address
	asset: Address
	amount: bigint
	/** True for `supplyIdle`, false for `withdrawIdle`. There is no third direction. */
	supply: boolean
	deadline: bigint
}
