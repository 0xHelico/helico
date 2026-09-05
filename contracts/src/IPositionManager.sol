// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The slice of Uniswap v4's PositionManager the vault needs.
/// @dev Kept minimal on purpose: the vault validates typed parameters and makes these calls
///      itself. It never forwards router calldata, which it could not check without decoding
///      it on-chain.
interface IPositionManager {
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
    function ownerOf(uint256 tokenId) external view returns (address);
    function getPositionLiquidity(uint256 tokenId) external view returns (uint128 liquidity);
}
