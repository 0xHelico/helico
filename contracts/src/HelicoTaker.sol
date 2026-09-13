// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IAqua} from "@1inch/aqua/interfaces/IAqua.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {HelicoMandateSwap, SwapMandate} from "./HelicoMandateSwap.sol";
import {IHelicoMandateSwapCallback} from "./IHelicoMandateSwapCallback.sol";

/// @title HelicoTaker
/// @notice The door through which a plain wallet takes a `HelicoMandateSwap` position.
///
/// @dev `HelicoMandateSwap.swapExactIn` delivers the output first and then calls the taker back to
///      pay, and solc's EXTCODESIZE check before that call means an EOA cannot be the taker at all.
///      Every fill until now was a test contract on a fork. This is that contract for the chain:
///      the wallet hands over `amountIn`, this contract makes the swap with the wallet as `to`, and
///      in the callback it pays the maker through `Aqua.push` — which is the only way the app
///      accepts payment, because the maker's side of the ledger is Aqua's.
///
///      **What it holds: nothing, between transactions.** The tokens it is handed are pushed in
///      the same call; the approval to Aqua is sized to the amount and consumed by the push. It
///      keeps no owner, no fee, no allowance to anyone. What it cannot stop: a wallet that
///      approves it for more than one fill has trusted it for that much, so `take` pulls exactly
///      `amountIn` and nothing this contract does can move the rest.
///
///      **The callback answers only the app.** `helicoMandateSwapCallback` reverts for any other
///      caller, so nobody can make this contract pay for a swap it did not start — and it pays
///      only from what `take` pulled in this transaction, since it holds nothing else.
///
///      **The product's sentence, on this contract.** The maker's USDC is earning in a lending
///      market when a wallet calls `take`; the app pulls the receipt through Aqua and withdraws the
///      deficit inside the same swap; the wallet receives USDC that was, one call earlier, a
///      position in Morpho. The receipt of one `take` shows all of it.
contract HelicoTaker is IHelicoMandateSwapCallback {
    using SafeERC20 for IERC20;

    IAqua public immutable AQUA;
    HelicoMandateSwap public immutable APP;

    error OnlyApp(address caller);
    error Expired(uint256 deadline, uint256 now_);

    event Taken(
        address indexed taker,
        bytes32 indexed mandateHash,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    constructor(IAqua aqua, HelicoMandateSwap app) {
        AQUA = aqua;
        APP = app;
    }

    /// @notice Sell `amountIn` of one side of `mandate` for the other, to the caller.
    /// @param mandate The mandate, as the maker shipped it. Any difference changes the hash and
    ///        the app answers for a position that does not exist.
    /// @param zeroForOne True to sell `token0` for `token1`.
    /// @param amountIn What the caller pays. Pulled from the caller, so they must have approved it.
    /// @param amountOutMin The least the caller accepts. A position is takeable by anyone at the
    ///        price the maker wrote, so a fill without a floor accepts whatever it has become.
    /// @param deadline Unix seconds after which this reverts. A quote is a price and prices go stale.
    /// @return amountOut What the caller received.
    function take(
        SwapMandate calldata mandate,
        bool zeroForOne,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 deadline
    ) external returns (uint256 amountOut) {
        if (block.timestamp > deadline) revert Expired(deadline, block.timestamp);
        address tokenIn = zeroForOne ? mandate.token0 : mandate.token1;
        address tokenOut = zeroForOne ? mandate.token1 : mandate.token0;
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        amountOut = APP.swapExactIn(mandate, zeroForOne, amountIn, amountOutMin, msg.sender, "");
        emit Taken(msg.sender, keccak256(abi.encode(mandate)), tokenIn, tokenOut, amountIn, amountOut);
    }

    /// @inheritdoc IHelicoMandateSwapCallback
    function helicoMandateSwapCallback(
        address tokenIn,
        address,
        uint256 amountIn,
        uint256,
        address maker,
        address app,
        bytes32 mandateHash,
        bytes calldata
    ) external {
        if (msg.sender != address(APP)) revert OnlyApp(msg.sender);
        IERC20(tokenIn).forceApprove(address(AQUA), amountIn);
        AQUA.push(maker, app, mandateHash, tokenIn, amountIn);
    }
}
