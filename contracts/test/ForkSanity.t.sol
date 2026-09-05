// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./ForkBase.sol";
import {MandateLib, PoolKey} from "../src/Mandate.sol";

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
