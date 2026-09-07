// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IAqua} from "@1inch/aqua/interfaces/IAqua.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {HelicoMandateSwap, SwapMandate} from "../src/HelicoMandateSwap.sol";
import {IHelicoMandateSwapCallback} from "../src/IHelicoMandateSwapCallback.sol";

/// @notice A plain ERC20 with an open mint, so a test can fund anyone.
contract TestToken is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice An ERC20 that keeps a cut of every transfer.
/// @dev Exists to demonstrate that Aqua's ledger credits the nominal amount while the maker
///      receives less, so the two drift apart. Not supported by the app; the test that uses it
///      documents the drift rather than claiming a fix.
contract FeeOnTransferToken is ERC20 {
    uint256 public immutable FEE_BPS;

    constructor(uint256 feeBps) ERC20("FeeOnTransfer", "FOT") {
        FEE_BPS = feeBps;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = value * FEE_BPS / 10_000;
        super._update(from, to, value - fee);
        super._update(from, address(0xFEE), fee);
    }
}

/// @notice A taker that behaves: it calls the app and pays what it owes in the callback.
///
/// @dev Every negative test that expects a refusal uses one of these, funded and approved, so
///      that removing the rule under test would let the swap *succeed*. A taker that cannot pay
///      would revert for its own reasons and prove nothing — and a plain EOA would revert
///      earlier still, on the EXTCODESIZE check solc emits before the callback.
contract PayingTaker is IHelicoMandateSwapCallback {
    IAqua public immutable AQUA;

    constructor(IAqua aqua) {
        AQUA = aqua;
    }

    function approveAqua(address token) external {
        IERC20(token).approve(address(AQUA), type(uint256).max);
    }

    function swap(
        HelicoMandateSwap app,
        SwapMandate calldata mandate,
        bool zeroForOne,
        uint256 amountIn,
        uint256 amountOutMin,
        address to
    ) external returns (uint256) {
        return app.swapExactIn(mandate, zeroForOne, amountIn, amountOutMin, to, "");
    }

    /// @dev Several swaps against one mandate in a single transaction. The lock is released at
    ///      the end of each call, so this is allowed -- which is exactly what a test needs in
    ///      order to show that the ceiling bounds one swap and not a transaction's total.
    function swapMany(
        HelicoMandateSwap app,
        SwapMandate calldata mandate,
        bool zeroForOne,
        uint256 amountIn,
        uint256 times
    ) external returns (uint256 total) {
        for (uint256 i = 0; i < times; i++) {
            total += app.swapExactIn(mandate, zeroForOne, amountIn, 0, address(this), "");
        }
    }

    function helicoMandateSwapCallback(
        address tokenIn,
        address,
        uint256 amountIn,
        uint256,
        address maker,
        address app,
        bytes32 mandateHash,
        bytes calldata
    ) external virtual {
        AQUA.push(maker, app, mandateHash, tokenIn, amountIn);
    }
}

/// @notice A taker that takes delivery and pays nothing.
contract FreeloadingTaker is PayingTaker {
    constructor(IAqua aqua) PayingTaker(aqua) {}

    function helicoMandateSwapCallback(
        address,
        address,
        uint256,
        uint256,
        address,
        address,
        bytes32,
        bytes calldata
    ) external override {}
}

/// @notice A taker that re-enters the same mandate from inside its own callback.
///
/// @dev The attack this models is real and was measured against an unguarded copy of the app:
///      two overlapping swaps each snapshot the same input balance, one payment satisfies both
///      checks, and the maker delivers twice for one payment. `nonReentrantStrategy` is what
///      makes it impossible.
contract SameMandateReentrantTaker is PayingTaker {
    HelicoMandateSwap private _app;
    SwapMandate private _mandate;
    bool private _entered;

    constructor(IAqua aqua) PayingTaker(aqua) {}

    function arm(HelicoMandateSwap app_, SwapMandate calldata mandate_) external {
        _app = app_;
        _mandate = mandate_;
    }

    function helicoMandateSwapCallback(
        address tokenIn,
        address,
        uint256 amountIn,
        uint256,
        address maker,
        address app,
        bytes32 mandateHash,
        bytes calldata
    ) external override {
        if (!_entered) {
            _entered = true;
            _app.swapExactIn(_mandate, true, amountIn, 0, address(this), "");
        }
        AQUA.push(maker, app, mandateHash, tokenIn, amountIn);
    }
}

/// @notice A taker that, inside one mandate's callback, swaps against a different mandate.
///
/// @dev Allowed by design: the reentrancy lock is keyed by `(maker, mandateHash)`, so sibling
///      mandates of the same maker do not collide. The test that uses this documents the limit
///      -- any per-maker accumulator an app might add would be wrong here.
contract SiblingMandateTaker is PayingTaker {
    HelicoMandateSwap private _app;
    SwapMandate private _sibling;
    uint256 private _siblingAmountIn;
    bool private _entered;

    constructor(IAqua aqua) PayingTaker(aqua) {}

    function arm(HelicoMandateSwap app_, SwapMandate calldata sibling_, uint256 amountIn_) external {
        _app = app_;
        _sibling = sibling_;
        _siblingAmountIn = amountIn_;
    }

    function helicoMandateSwapCallback(
        address tokenIn,
        address,
        uint256 amountIn,
        uint256,
        address maker,
        address app,
        bytes32 mandateHash,
        bytes calldata
    ) external override {
        if (!_entered) {
            _entered = true;
            _app.swapExactIn(_sibling, true, _siblingAmountIn, 0, address(this), "");
        }
        AQUA.push(maker, app, mandateHash, tokenIn, amountIn);
    }
}
