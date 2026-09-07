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
