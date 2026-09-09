// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice The slice of Compound v3 this venue needs, and nothing more.
///
/// @dev Written the way `ILendingVenue` is written, and for the same reason: an interface that can
///      do more than the code does is a promise nobody keeps. Comet can borrow, absorb, buy
///      collateral and transfer positions; none of that appears here, so none of it can be reached
///      by a mistake in this file.
///
///      Read from `cUSDCv3` on Arbitrum One (`0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf`) rather
///      than from Compound's documentation:
///
///          baseToken()                     0xaf88d065e77c8cC2239327C5EDb3A432268e5831  (USDC)
///          decimals()                      6
///          getUtilization()                797601228640330007          79.76%
///          getSupplyRate(utilization)      910503685                   per second, scaled 1e18
///
///      `supply` and `withdraw` act on `msg.sender`'s own position, which is why this venue holds
///      the position itself rather than trying to act on a maker's.
interface IComet {
    /// @notice The asset this market is denominated in. Compound's spelling of `UNDERLYING_ASSET_ADDRESS`.
    function baseToken() external view returns (address);

    /// @notice Supply `amount` of `asset` from `msg.sender`, crediting `msg.sender`'s position.
    function supply(address asset, uint256 amount) external;

    /// @notice Withdraw `amount` of `asset` from `msg.sender`'s position, sending it to `to`.
    function withdrawTo(address to, address asset, uint256 amount) external;

    /// @notice The present value of an account's base position, interest included.
    /// @dev This accrues, so it is a moving number and is the only source of truth for what this
    ///      venue's shares are backed by.
    function balanceOf(address account) external view returns (uint256);

    /// @notice Borrowed over supplied, scaled by 1e18.
    function getUtilization() external view returns (uint256);

    /// @notice The supply rate at a given utilisation, **per second**, scaled by 1e18.
    function getSupplyRate(uint256 utilization) external view returns (uint64);
}
