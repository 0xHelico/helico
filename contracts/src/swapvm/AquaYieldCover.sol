// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// Powered by SwapVM — © Degensoft Ltd 2025
/// @custom:license-url https://github.com/1inch/swap-vm/blob/main/LICENSES/SwapVM-1.1.txt
/// @custom:changes New instruction added by Helico on 8 September 2026. Not part of the
///                 Licensed Work as published by Degensoft.

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IAqua} from "@1inch/aqua/interfaces/IAqua.sol";

import {Context} from "@1inch/swap-vm/libs/VM.sol";

import {ILendingVenue} from "../ILendingVenue.sol";

/// @title AquaYieldCover
/// @notice A SwapVM instruction that lets a maker's committed liquidity sit in a lending market
///         until the moment a swap actually needs it.
///
/// @dev **The gap this fills.** Every curve SwapVM ships prices against `balanceOut`, and Aqua
///      answers that from what the maker shipped — a number, written with no transfer and no
///      balance check. So a maker may commit 43,000 USDC while holding 5,000, and the curve is
///      right to price against 43,000. What breaks is the end of the swap: `_transferOut` pulls
///      the tokens themselves, and tokens earning yield elsewhere are not there to pull.
///
///      Nothing in the published instruction set closes that, because none of them has a concept
///      of a lending market — they compute prices. This one moves capital, once, for exactly the
///      shortfall, in the same transaction that needs it.
///
///      **Where it goes in a program: after the curve.** It reads `ctx.swap.amountOut`, which is
///      the curve's output, so a program that runs it first covers a shortfall that has not been
///      computed yet and covers nothing.
///
///      **Encoding:** `[address pool]`, 20 bytes. The receipt is not an argument on purpose. A
///      receipt named by the maker is something the maker could have made up, and `POOL()` on a
///      forged one returns the real pool; asking the pool which receipt it issues is the only
///      direction that cannot be faked.
contract AquaYieldCover {
    /// @dev The ledger this instruction pulls the receipt through. Its `pull` is keyed on
    ///      `msg.sender` as the app, so only the router this instruction is compiled into can
    ///      spend the maker's shipped receipt — the same authority the curve above it uses.
    IAqua private immutable _AQUA;

    error AquaYieldCoverVenueDoesNotListToken(address pool, address token);
    error AquaYieldCoverDidNotCover(address token, uint256 held, uint256 needed);
    error AquaYieldCoverRetainedReceipt(address receipt, uint256 held);

    constructor(address aqua) {
        _AQUA = IAqua(aqua);
    }

    function _aquaYieldCoverXD(Context memory ctx, bytes calldata args) internal {
        uint256 needed = ctx.swap.amountOut;
        if (needed == 0) return;

        address maker = ctx.query.maker;
        address tokenOut = ctx.query.tokenOut;

        uint256 held = IERC20(tokenOut).balanceOf(maker);
        if (held >= needed) return;

        // A quote must not move anything, and does not need to: the price came from the curve
        // above, which already read the committed balance. Returning here is what keeps
        // `quote` answerable by a static call.
        if (ctx.vm.isStaticContext) return;

        address pool = address(bytes20(args[0:20]));
        address receipt = ILendingVenue(pool).getReserveAToken(tokenOut);
        require(receipt != address(0), AquaYieldCoverVenueDoesNotListToken(pool, tokenOut));

        uint256 deficit = needed - held;

        // The receipt lands here rather than at the maker because `withdraw` burns it from
        // `msg.sender`. It leaves in the same call; the assertion below is what proves it.
        uint256 beforePull = IERC20(receipt).balanceOf(address(this));
        _AQUA.pull(maker, ctx.query.orderHash, receipt, deficit, address(this));
        ILendingVenue(pool).withdraw(tokenOut, deficit, maker);

        uint256 heldNow = IERC20(receipt).balanceOf(address(this));
        if (heldNow > beforePull) {
            SafeERC20.safeTransfer(IERC20(receipt), maker, heldNow - beforePull);
            heldNow = IERC20(receipt).balanceOf(address(this));
        }
        require(heldNow == beforePull, AquaYieldCoverRetainedReceipt(receipt, heldNow));

        // Lending markets round against the supplier, so `withdraw` may hand back a unit less
        // than asked. Checking the maker's balance rather than the withdrawal's return value is
        // what makes this an assertion about the thing the next step needs.
        uint256 nowHeld = IERC20(tokenOut).balanceOf(maker);
        require(nowHeld >= needed, AquaYieldCoverDidNotCover(tokenOut, nowHeld, needed));
    }
}
