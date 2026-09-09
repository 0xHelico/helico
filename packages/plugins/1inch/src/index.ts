/**
 * 1inch Aqua, and the SwapVM programs that price on it.
 *
 * Aqua is an allowance ledger, not a vault: `ship` writes an entry and moves nothing, `pull`
 * sends the maker's tokens straight to the recipient, and the wallet is never not in custody of
 * its own money. What this package builds is the thing filed in that ledger — a concentrated
 * position, priced by 1inch's deployed SwapVM rather than by arithmetic of ours.
 *
 * The pricing is theirs on purpose. `xyc-swap` is one of thirteen instructions their SDK ships
 * and it is the one their example is named after; `concentrate` is the same family with a band.
 * Writing that curve ourselves would be new fixed-point maths in a contract, which is not what
 * the remaining days are for.
 */
export * from './addresses'
export * from './calldata'
export * from './mandate'
export * from './price'
export * from './strategy'
