// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./ForkBase.sol";
import {MandateLib, PoolKey} from "../src/Mandate.sol";
import {TickMath} from "../src/lib/TickMath.sol";

/// @notice Proves the fork harness reaches the real chain and reads it correctly, so a failure
///         in the swap tests is about the vault rather than about the environment.
contract ForkSanityTest is ForkBase {
    using MandateLib for PoolKey;

    function test_ReadsTheDemoPool() public {
        _fork();

        (uint160 sqrtPriceX96, int24 tick,, uint24 lpFee) = STATE_VIEW.getSlot0(demoPool.hashPoolKey());
        assertTrue(sqrtPriceX96 != 0, "the demo pool is initialised");
        assertEq(lpFee, 10_000, "1% fee, hundredths of a bip against MAX_LP_FEE of 1,000,000");

        emit log_named_int("tick", tick);
        emit log_named_uint("sqrtPriceX96", sqrtPriceX96);
        emit log_named_uint("active liquidity", STATE_VIEW.getLiquidity(demoPool.hashPoolKey()));
        emit log_named_uint("nextTokenId", POSITION_MANAGER.nextTokenId());
    }

    /// @notice The packed-word unpacking the vault relies on, checked against a live position
    ///         rather than against a mock that packs it the same way we unpack it.
    function test_UnpacksALivePositionsRange() public {
        _fork();

        uint256 tokenId = POSITION_MANAGER.nextTokenId() - 1;
        (PoolKey memory key,) = POSITION_MANAGER.getPoolAndPositionInfo(tokenId);
        (int24 lower, int24 upper) = _rangeOf(tokenId);

        assertTrue(lower < upper, "ordered");
        assertEq(lower % key.tickSpacing, 0, "lower is on the pool's spacing");
        assertEq(upper % key.tickSpacing, 0, "upper is on the pool's spacing");

        emit log_named_int("lower", lower);
        emit log_named_int("upper", upper);
        emit log_named_int("current", _tickOf(key));
    }
}

/// @notice The vendored `TickMath`, checked against the live pool rather than against itself.
contract ForkTickMathTest is ForkBase {
    using MandateLib for PoolKey;

    /// @dev The defining property: the pool's price sits at or above the price of its current
    ///      tick and below the next one. If a constant had been mistyped while vendoring, this
    ///      is where it would show — and it cannot be satisfied by an implementation that
    ///      merely agrees with our own copy of the maths.
    function test_BracketsTheLivePoolPrice() public {
        _fork();

        (uint160 sqrtPriceX96, int24 tick,,) = STATE_VIEW.getSlot0(demoPool.hashPoolKey());

        assertGe(sqrtPriceX96, TickMath.getSqrtPriceAtTick(tick), "at or above the current tick");
        assertLt(sqrtPriceX96, TickMath.getSqrtPriceAtTick(tick + 1), "below the next tick");
    }

    /// @dev The price limit the swap leg passes to the pool is derived from the committed
    ///      range, so it must sit on the correct side of the current price in both directions.
    function test_TheRangeEdgesBracketTheCurrentPrice() public {
        _fork();

        (uint160 sqrtPriceX96, int24 tick,,) = STATE_VIEW.getSlot0(demoPool.hashPoolKey());
        int24 spacing = demoPool.tickSpacing;
        int24 lower = (tick / spacing) * spacing - spacing * 10;
        int24 upper = lower + spacing * 20;

        assertLt(TickMath.getSqrtPriceAtTick(lower), sqrtPriceX96, "swapping down stops below spot");
        assertGt(TickMath.getSqrtPriceAtTick(upper), sqrtPriceX96, "swapping up stops above spot");
    }

    function test_MatchesTheKnownBoundaries() public pure {
        assertEq(TickMath.getSqrtPriceAtTick(0), 79228162514264337593543950336, "1.0 in Q64.96");
        assertEq(TickMath.getSqrtPriceAtTick(TickMath.MIN_TICK), TickMath.MIN_SQRT_PRICE);
        assertEq(TickMath.getSqrtPriceAtTick(TickMath.MAX_TICK), TickMath.MAX_SQRT_PRICE);
    }
}
