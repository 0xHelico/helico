// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {IPositionManager} from "../src/IPositionManager.sol";
import {IPoolManager} from "../src/IPoolManager.sol";
import {IStateView} from "../src/IStateView.sol";
import {MandateLib, PoolKey} from "../src/Mandate.sol";

/// @notice Shared setup for tests that run against the real Uniswap v4 on Robinhood Chain.
///
/// @dev **Why these do not pin a block.** The public RPC is not an archive node — it keeps
///      roughly 6,100 blocks of state, and at a 0.101 second block time that is about ten
///      minutes. A pinned `--fork-block-number` works on the machine that warmed Foundry's
///      cache and fails for everyone else within the hour.
///
///      So these fork `latest` and derive everything from what they read. Nothing is
///      hard-coded about where the price is or whether a position is in range; a test that
///      needs a particular condition asserts it and skips if the chain does not currently
///      offer it, rather than failing for a reason that has nothing to do with the code.
abstract contract ForkBase is Test {
    using MandateLib for PoolKey;

    IPositionManager constant POSITION_MANAGER = IPositionManager(0x58daec3116aae6D93017bAAea7749052E8a04fA7);
    IStateView constant STATE_VIEW = IStateView(0xF3334192D15450CdD385c8B70e03f9A6bD9E673b);
    IPoolManager constant POOL_MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);

    uint256 constant ROBINHOOD_MAINNET = 4663;

    /// @dev ETH/par, 1% fee, spacing 10. The deepest pool surveyed on this chain by a wide
    ///      margin, and a hundredth of the fee of the 20% launch pools that dominate it — a
    ///      swap leg is only defensible somewhere like this. `currency0` is native, which is
    ///      also the case the vault most needs to prove it handles.
    PoolKey internal demoPool = PoolKey({
        currency0: address(0),
        currency1: 0x507B6F349a80114097A67B8b4677367acC15b220,
        fee: 10_000,
        tickSpacing: 10,
        hooks: address(0)
    });

    bool internal forked;

    /// @dev Marks the test skipped rather than passed when there is no endpoint. A test that
    ///      reports green without having run is the same lie as a mock that cannot refuse
    ///      anything, and this repo has already paid for that once.
    function _fork() internal {
        try vm.createSelectFork("robinhood") {
            forked = block.chainid == ROBINHOOD_MAINNET;
        } catch {
            forked = false;
        }
        if (!forked) {
            emit log("no endpoint: set ROBINHOOD_RPC_URL to run the fork suite");
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
