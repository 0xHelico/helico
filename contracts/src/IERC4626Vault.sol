// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice The slice of ERC-4626 a venue needs, and nothing more.
///
/// @dev Written narrow for the reason `ILendingVenue` is: an interface that can do more than the
///      code does is a promise nobody keeps. `mint`, `redeem`, `previewDeposit` and the rest of the
///      standard are absent because no line reaches for them.
///
///      Read from `bbqUSDC` on Arbitrum One (`0x5c0C306Aaa9F877de636f4d5822cA9F2E81563BA`), a
///      Steakhouse MetaMorpho vault, rather than from the standard:
///
///          asset()                   0xaf88d065e77c8cC2239327C5EDb3A432268e5831  (USDC)
///          decimals()                18            ← **not** the asset's six
///          totalAssets()             2396493361729                2.396M USDC
///          previewWithdraw(1000e6)   958848557210622751442        9.588e20 shares
///          MORPHO()                  0x6c247b1F6182318877311737BaC0844bAa518F5e
///
///      That decimals mismatch is the reason a venue over a 4626 vault cannot simply pass amounts
///      through: nine hundred and fifty-eight *sextillion* of something is one thousand USDC.
interface IERC4626Vault {
    function asset() external view returns (address);

    /// @notice Deposit `assets`, crediting vault shares to `receiver`. Returns shares minted.
    function deposit(uint256 assets, address receiver) external returns (uint256);

    /// @notice Withdraw `assets` to `receiver`, burning `owner`'s shares. Returns shares burned.
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256);

    /// @notice What `owner` could withdraw right now, after the market's own liquidity.
    /// @dev The honest ceiling for a venue built on this. A MetaMorpho vault holds almost nothing
    ///      idle — this one held 10,000 wei of USDC against 2.4M supplied — so the vault's own
    ///      balance is not the number that binds and this is.
    function maxWithdraw(address owner) external view returns (uint256);

    /// @notice What `shares` are worth in assets, at the current price.
    function convertToAssets(uint256 shares) external view returns (uint256);

    function balanceOf(address account) external view returns (uint256);
}
