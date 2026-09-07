// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice What a taker of `HelicoMandateSwap` must implement.
///
/// @dev The callback lands on `msg.sender` — the contract that called `swapExactIn`, which is
///      not necessarily the address receiving the output. That is a real constraint and not a
///      style choice: a high-level call to a function with no return value makes solc emit an
///      `EXTCODESIZE` check first, so a plain EOA taker always reverts here, gate or no gate.
///      An agent therefore acts through a contract it controls, and that contract's address is
///      what a mandate names in `agent`.
interface IHelicoMandateSwapCallback {
    /// @notice Pay for a swap whose output has already been delivered.
    /// @dev The implementation must call `AQUA.push(maker, app, mandateHash, tokenIn, amountIn)`
    ///      having approved Aqua — not this app — to move `tokenIn`. Failing to do so reverts
    ///      the whole transaction, output transfer included.
    /// @param tokenIn The token the taker owes.
    /// @param tokenOut The token the taker has already received.
    /// @param amountIn The amount owed.
    /// @param amountOut The amount already delivered.
    /// @param maker The mandate's maker, whose wallet the tokens move to.
    /// @param app This contract, to be passed back to Aqua as the `app` argument of `push`.
    /// @param mandateHash Identifies the mandate to credit.
    /// @param takerData Opaque bytes forwarded from the swap call.
    function helicoMandateSwapCallback(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        address maker,
        address app,
        bytes32 mandateHash,
        bytes calldata takerData
    ) external;
}
