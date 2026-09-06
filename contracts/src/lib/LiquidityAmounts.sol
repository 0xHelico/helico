// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title How much liquidity a pair of amounts buys, at a price.
///
/// @dev The three formulas are Uniswap's, from `v4-periphery`'s `LiquidityAmounts`, which is
///      itself v3's. Vendored rather than imported for the same reason `TickMath` is: this
///      contract needs three pure functions, not a dependency tree, and the arithmetic is
///      short enough to read in one sitting.
///
///      Two differences from upstream, both deliberate:
///
///      - `FullMath.mulDiv` is `Math.mulDiv` from OpenZeppelin, which this contract already
///        has and which has the same 512-bit intermediate.
///      - Upstream returns `uint128` by unchecked truncation. Here a result that does not fit
///        **saturates** instead. Truncation would wrap a huge number down to a small one and
///        mint dust; reverting would be worse still, because overflow here is not an error.
///        It happens whenever the price sits a hair below the range's top — which is exactly
///        where the vault's own swap price limit puts it — and it means only that this side
///        is not the one that binds. The caller takes a minimum immediately afterwards, and
///        saturation is the value that makes that minimum come out right.
///
///      Every function rounds **down**, which is the direction that matters: the caller is
///      asking what it can afford, and an answer rounded up is one it cannot.
library LiquidityAmounts {
    uint256 private constant Q96 = 0x1000000000000000000000000;

    /// @dev `L = amount0 * (sqrtA * sqrtB / Q96) / (sqrtB - sqrtA)`, for a range entirely
    ///      above the price, where the position is all token0.
    function getLiquidityForAmount0(uint160 sqrtA, uint160 sqrtB, uint256 amount0)
        internal
        pure
        returns (uint128)
    {
        if (sqrtA > sqrtB) (sqrtA, sqrtB) = (sqrtB, sqrtA);
        uint256 intermediate = Math.mulDiv(sqrtA, sqrtB, Q96);
        return _toUint128(Math.mulDiv(amount0, intermediate, sqrtB - sqrtA));
    }

    /// @dev `L = amount1 * Q96 / (sqrtB - sqrtA)`, for a range entirely below the price, where
    ///      the position is all token1.
    function getLiquidityForAmount1(uint160 sqrtA, uint160 sqrtB, uint256 amount1)
        internal
        pure
        returns (uint128)
    {
        if (sqrtA > sqrtB) (sqrtA, sqrtB) = (sqrtB, sqrtA);
        return _toUint128(Math.mulDiv(amount1, Q96, sqrtB - sqrtA));
    }

    /// @notice The most liquidity `amount0` and `amount1` can fund over `[sqrtA, sqrtB)` at
    ///         `sqrtP`.
    ///
    /// @dev Inside the range both sides are needed and the smaller one decides, which is the
    ///      whole reason an out-of-range position cannot re-centre without a swap: one of the
    ///      two amounts is zero, so the minimum is zero.
    function getLiquidityForAmounts(
        uint160 sqrtP,
        uint160 sqrtA,
        uint160 sqrtB,
        uint256 amount0,
        uint256 amount1
    ) internal pure returns (uint128) {
        if (sqrtA > sqrtB) (sqrtA, sqrtB) = (sqrtB, sqrtA);
        if (sqrtP <= sqrtA) return getLiquidityForAmount0(sqrtA, sqrtB, amount0);
        if (sqrtP >= sqrtB) return getLiquidityForAmount1(sqrtA, sqrtB, amount1);
        uint128 l0 = getLiquidityForAmount0(sqrtP, sqrtB, amount0);
        uint128 l1 = getLiquidityForAmount1(sqrtA, sqrtP, amount1);
        return l0 < l1 ? l0 : l1;
    }

    function _toUint128(uint256 x) private pure returns (uint128) {
        return x > type(uint128).max ? type(uint128).max : uint128(x);
    }
}
