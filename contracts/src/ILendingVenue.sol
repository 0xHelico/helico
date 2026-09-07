// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice The slice of a lending market this app needs, and nothing more.
///
/// @dev Deliberately narrow. A mandate names the venues it permits, and the app calls only these
///      three functions on them — so adding Compound or Morpho later is an address in a mandate
///      rather than a change here.
///
///      Named after Aave v3's own signatures because that is the first venue supported, but
///      nothing in the app assumes Aave: `withdraw` returning the amount and `getReserveData`
///      being absent from this interface are both deliberate.
interface ILendingVenue {
    /// @notice Burn the caller's receipt tokens and send `amount` of `asset` to `to`.
    /// @dev Returns exactly `amount`, or reverts. `type(uint256).max` sweeps the whole position.
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);

    /// @notice What the market can actually pay out right now.
    /// @dev On Aave v3 this is the *virtual* balance, which is the number that binds. The token
    ///      balance of the receipt contract is a different figure — the two disagree by
    ///      thousands of USDC on Arbitrum, and using the wrong one turns a clean refusal into an
    ///      arithmetic panic from inside the market.
    function getVirtualUnderlyingBalance(address asset) external view returns (uint128);

    /// @notice The receipt token this market issues for `asset`.
    /// @dev The market is asked, never the receipt. A receipt is a contract the maker names in
    ///      their mandate, so anything it says about itself is something the maker could have
    ///      made up; the pool being withdrawn from is the only party in the call with no reason
    ///      to lie about which receipt it burns. Asking the receipt instead — `POOL()` on an
    ///      aToken — reads as the same check and is not one: a forged receipt simply returns the
    ///      real pool's address and passes.
    ///
    ///      Verified against Aave v3 on Arbitrum: `getReserveAToken(USDC)` on
    ///      `0x794a61358D6845594F94dc1DB02A252b5b4814aD` returns aUSDC
    ///      `0x724dc807b04555b71ed48a6896b6F41593b8C637`.
    function getReserveAToken(address asset) external view returns (address);

    /// @notice A user's aggregate position, used only to establish that they have no debt.
    /// @dev The app refuses to unwind for a maker who has borrowed. Aave blocks the withdrawal
    ///      of collateral for a borrower — a health check that only runs when a debt exists — so
    ///      a maker could otherwise disable their own mandate with one ordinary borrow, and the
    ///      failure would surface as a market error rather than as our refusal. A borrowing maker
    ///      can also be liquidated, which seizes the very position the mandate depends on.
    function getUserAccountData(address user)
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        );
}

/// @notice The one thing a receipt token must be able to tell us about itself.
///
/// @dev Without this, a mandate can name a receipt token that belongs to a *different* asset,
///      and the unwind spends an amount denominated in one token out of a budget denominated in
///      another. An audit demonstrated the result: a 3,216 USDC swap consuming 32 BTC of
///      receipt, because both are "3216440300" in their own units.
///
///      Aave's aToken exposes this. Any venue whose receipt cannot answer it is not one this
///      app can safely unwind, and is refused rather than trusted.
interface IReceiptToken {
    function UNDERLYING_ASSET_ADDRESS() external view returns (address);
}
