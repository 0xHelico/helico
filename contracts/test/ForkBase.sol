// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {IPositionManager} from "../src/IPositionManager.sol";
import {IPoolManager} from "../src/IPoolManager.sol";
import {IStateView} from "../src/IStateView.sol";
import {MandateLib, PoolKey} from "../src/Mandate.sol";

/// @notice Shared setup for tests that run against the real Uniswap v4 on Arbitrum One.
///
/// @dev **Why these do not pin a block.** They fork `latest` and derive everything from what
///      they read. Nothing is hard-coded about where the price is or whether a position is in
///      range; a test that needs a particular condition asserts it and skips if the chain does
///      not currently offer it, rather than failing for a reason unrelated to the code.
///
///      That started as a workaround — the chain this project first targeted served about ten
///      minutes of state, so a pinned block failed for everyone who had not warmed a cache. It
///      is kept because it is the better shape regardless: a fixture derived from the live pool
///      cannot go stale, and one pinned to a block silently stops testing what it claims.
abstract contract ForkBase is Test {
    using MandateLib for PoolKey;

    IPositionManager constant POSITION_MANAGER = IPositionManager(0xd88F38F930b7952f2DB2432Cb002E7abbF3dD869);
    IStateView constant STATE_VIEW = IStateView(0x76Fd297e2D437cd7f76d50F01AfE6160f86e9990);
    IPoolManager constant POOL_MANAGER = IPoolManager(0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32);

    uint256 constant ARBITRUM_ONE = 42161;

    /// @dev ETH/ARB at 0.05%, spacing 10 —
    ///      `poolId 0xb37da7d5beb04539b6c497a15794748fc0ce1da7afc61133e3253eff76229ae5`.
    ///
    ///      The fee matters to this product more than it looks: a re-centre pays a swap through
    ///      the position's own pool, so 0.05% is the difference between an action that recovers
    ///      more than it costs and one that does not. The chain we came from had this pool at
    ///      1%, and most of its pools between 6% and 20%.
    ///
    ///      `currency0` is native, so this still exercises the path the vault most needs to
    ///      prove it handles — `Currency.transfer` for the zero address is a bare `call`, and a
    ///      contract without `receive()` fails it with no diagnostic.
    PoolKey internal demoPool = PoolKey({
        currency0: address(0),
        currency1: 0x912CE59144191C1204E64559FE8253a0e49E6548,
        fee: 500,
        tickSpacing: 10,
        hooks: address(0)
    });

    bool internal forked;

    /// @dev Marks the test skipped rather than passed when there is no endpoint. A test that
    ///      reports green without having run is the same lie as a mock that cannot refuse
    ///      anything, and this repo has already paid for that once.
    function _fork() internal {
        try vm.createSelectFork("arbitrum") {
            forked = block.chainid == ARBITRUM_ONE;
        } catch {
            forked = false;
        }
        if (!forked) {
            emit log("no endpoint: set ARBITRUM_RPC_URL to run the fork suite");
            vm.skip(true);
        }
    }

    function _tickOf(PoolKey memory key) internal view returns (int24 tick) {
        (, tick,,) = STATE_VIEW.getSlot0(key.hashPoolKey());
    }

    /// @dev Reads a position's committed range straight out of the packed word, the same way
    ///      the vault does.
    function _rangeOf(uint256 tokenId) internal view returns (int24 lower, int24 upper) {
        (, uint256 info) = POSITION_MANAGER.getPoolAndPositionInfo(tokenId);
        assembly ("memory-safe") {
            lower := signextend(2, shr(8, info))
            upper := signextend(2, shr(32, info))
        }
    }

    function _isInRange(uint256 tokenId, PoolKey memory key) internal view returns (bool) {
        (int24 lower, int24 upper) = _rangeOf(tokenId);
        int24 tick = _tickOf(key);
        return tick >= lower && tick < upper;
    }
}
