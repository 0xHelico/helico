// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PoolKey} from "./Mandate.sol";

/// @notice The slice of Uniswap v4's PositionManager the vault needs.
/// @dev Signatures taken from v4-periphery `src/interfaces/IPositionManager.sol` and
///      `IERC721Permit_v4`. `getPoolAndPositionInfo` returns a packed `PositionInfo`; the
///      packing is documented at `HelicoVault._tickLower`.
interface IPositionManager {
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
    function ownerOf(uint256 tokenId) external view returns (address);
    function getPositionLiquidity(uint256 tokenId) external view returns (uint128 liquidity);
    /// @dev The id the next mint will be given. v4 assigns `nextTokenId++`, so reading it
    ///      before a batch that mints exactly once tells the vault which token it will get.
    function nextTokenId() external view returns (uint256);
    function getPoolAndPositionInfo(uint256 tokenId) external view returns (PoolKey memory, uint256 info);
    /// @dev Runs the same action loop as `modifyLiquidities` but assumes the PoolManager is
    ///      already unlocked. Its `isNotLocked` modifier guards the PositionManager's own
    ///      reentrancy lock, not the pool's, so it is callable from inside our unlock callback.
    ///      That is what lets the vault put a swap between the burn and the mint.
    function modifyLiquiditiesWithoutUnlock(bytes calldata actions, bytes[] calldata params) external payable;
}
