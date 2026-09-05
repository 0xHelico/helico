// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The slice of Uniswap v4's `StateView` lens the vault needs.
/// @dev v4 keeps pool state in transient-packed storage on the singleton PoolManager, so the
///      current tick is not readable through a plain getter. `StateView` is the periphery lens
///      that exposes it. `PoolId` is a user-defined type over `bytes32`, ABI-identical to the
///      `poolId` a mandate commits to.
interface IStateView {
    function getSlot0(bytes32 poolId)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);

    /// @notice The pool's currently active liquidity, used by fork tests to judge whether a
    ///         swap of a given size would move the price absurdly.
    function getLiquidity(bytes32 poolId) external view returns (uint128 liquidity);
}
