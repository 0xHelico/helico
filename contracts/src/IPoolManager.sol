// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PoolKey} from "./Mandate.sol";

/// @notice The slice of Uniswap v4's singleton PoolManager the vault needs to swap.
/// @dev Signatures taken from v4-core `src/interfaces/IPoolManager.sol` and
///      `src/types/PoolOperation.sol`. `Currency` is a user-defined type over `address` and
///      `BalanceDelta` one over `int256`, both ABI-identical to the plain types used here.
interface IPoolManager {
    /// @param amountSpecified Negative for exact input, positive for exact output.
    /// @param sqrtPriceLimitX96 The price the swap stops at, which is also its slippage bound.
    struct SwapParams {
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
    }

    /// @notice Takes the pool lock and calls `unlockCallback` back on the caller.
    function unlock(bytes calldata data) external returns (bytes memory);

    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData)
        external
        returns (int256 swapDelta);

    /// @notice Records the manager's balance of a currency before a transfer, so `settle` can
    ///         work out how much arrived.
    function sync(address currency) external;

    /// @notice Pays what the caller owes, using the amount transferred in since `sync`.
    function settle() external payable returns (uint256 paid);

    /// @notice Withdraws what the caller is owed.
    function take(address currency, address to, uint256 amount) external;
}

/// @notice Implemented by whoever calls `IPoolManager.unlock`.
/// @dev v4-core `src/interfaces/callback/IUnlockCallback.sol`.
interface IUnlockCallback {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}
