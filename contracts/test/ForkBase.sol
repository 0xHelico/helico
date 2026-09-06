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

    // Set once by the constructor, so a fork suite can name a different chain without a second
    // copy of the helpers below. They were `constant` while there was one chain; the moment a
    // hooked pool had to come from somewhere other than Arbitrum, the constants were the whole
    // obstacle and the rest of this file was already chain-agnostic.
    IPositionManager internal POSITION_MANAGER;
    IStateView internal STATE_VIEW;
    IPoolManager internal POOL_MANAGER;

    /// @dev The `[rpc_endpoints]` alias in `foundry.toml`, and the chain the fork must turn out
    ///      to be. Checking the id is what stops a mis-set endpoint from silently testing the
    ///      wrong chain against the right addresses.
    string internal forkAlias;
    uint256 internal expectedChainId;
    /// @dev The environment variable behind `forkAlias`, so the skip message names the one to set.
    string internal rpcEnvVar;

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
    PoolKey internal demoPool;

    bool internal forked;

    constructor(
        string memory forkAlias_,
        string memory rpcEnvVar_,
        uint256 expectedChainId_,
        IPositionManager positionManager_,
        IStateView stateView_,
        IPoolManager poolManager_,
        PoolKey memory demoPool_
    ) {
        forkAlias = forkAlias_;
        rpcEnvVar = rpcEnvVar_;
        expectedChainId = expectedChainId_;
        POSITION_MANAGER = positionManager_;
        STATE_VIEW = stateView_;
        POOL_MANAGER = poolManager_;
        demoPool = demoPool_;
    }

    /// @dev Marks the test skipped rather than passed when there is no endpoint. A test that
    ///      reports green without having run is the same lie as a mock that cannot refuse
    ///      anything, and this repo has already paid for that once.
    ///
    ///      `HELICO_FORK_BLOCK` pins a block, for reproducing only. Reading the live pool means
    ///      a failure that depends on where the price happens to sit disappears on the next run,
    ///      and chasing one without a pin is a coin flip. Leave it unset everywhere else — a
    ///      pinned suite silently stops testing what it claims.
    function _fork() internal {
        uint256 pinned = vm.envOr("HELICO_FORK_BLOCK", uint256(0));
        forked = pinned == 0 ? _select() : _select(pinned);
        if (!forked) {
            emit log(string.concat("no endpoint: set ", rpcEnvVar, " to run this fork suite"));
            vm.skip(true);
        }
    }

    function _select() private returns (bool) {
        try vm.createSelectFork(forkAlias) {
            return block.chainid == expectedChainId;
        } catch {
            return false;
        }
    }

    function _select(uint256 blockNumber) private returns (bool) {
        try vm.createSelectFork(forkAlias, blockNumber) {
            return block.chainid == expectedChainId;
        } catch {
            return false;
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

/// @notice Arbitrum One, and the hook-less ETH/ARB pool every existing fork test uses.
///
/// @dev A named base rather than the same seven arguments in each test file. The pool's fee
///      matters to this product more than it looks: a re-centre pays a swap through the
///      position's own pool, so 0.05% is the difference between an action that recovers more
///      than it costs and one that does not. The chain we came from had this pool at 1%, and
///      most of its pools between 6% and 20%.
///
///      `currency0` is native, so this exercises the path the vault most needs to prove it
///      handles — `Currency.transfer` for the zero address is a bare `call`, and a contract
///      without `receive()` fails it with no diagnostic.
///
///      `poolId 0xb37da7d5beb04539b6c497a15794748fc0ce1da7afc61133e3253eff76229ae5`.
abstract contract ArbitrumFork is ForkBase {
    constructor()
        ForkBase(
            "arbitrum",
            "ARBITRUM_RPC_URL",
            42161,
            IPositionManager(0xd88F38F930b7952f2DB2432Cb002E7abbF3dD869),
            IStateView(0x76Fd297e2D437cd7f76d50F01AfE6160f86e9990),
            IPoolManager(0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32),
            PoolKey({
                currency0: address(0),
                currency1: 0x912CE59144191C1204E64559FE8253a0e49E6548,
                fee: 500,
                tickSpacing: 10,
                hooks: address(0)
            })
        )
    {}
}

/// @notice Ethereum mainnet, and a pool whose hook is a real one someone else deployed.
///
/// @dev The pool is Angstrom's USDC/WETH — `poolId`
///      `0xe500210c7ea6bfd9f69dce044b09ef384ec2b34832f132baec3b418208e3a657`. It is here because
///      it is the only kind of fixture that proves anything: a hook this project did not write,
///      on a pair people actually trade, with liquidity in it right now.
///
///      **Why not Arbitrum.** Two independent scans of the chain found no hooked pool there with
///      a major pair and real trading. Writing our own hook would have proved that our hook and
///      our vault agree, which is not the claim.
///
///      **What this hook does, read from the chain rather than from its flags.** Calling each
///      callback directly in the PoolManager's shoes, from an address with no relationship to
///      Angstrom: `beforeAddLiquidity` and `beforeRemoveLiquidity` accept, and `beforeSwap`
///      reverts `CannotSwapWhileLocked()` — Angstrom opens the pool only inside its own auction
///      bundle. The flag bits alone would have said "gates liquidity", which is the opposite of
///      what the code does; they are declared so Angstrom can meter its own reward accounting,
///      not to refuse anyone.
///
///      `fee` is `0x800000`, `LPFeeLibrary.DYNAMIC_FEE_FLAG`, not a literal 838.8608%.
abstract contract MainnetFork is ForkBase {
    constructor()
        ForkBase(
            "mainnet",
            "MAINNET_RPC_URL",
            1,
            IPositionManager(0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e),
            IStateView(0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227),
            IPoolManager(0x000000000004444c5dc75cB358380D2e3dE08A90),
            PoolKey({
                currency0: 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48, // USDC
                currency1: 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2, // WETH
                fee: 0x800000,
                tickSpacing: 10,
                hooks: 0x0000000aa232009084Bd71A5797d089AA4Edfad4
            })
        )
    {}
}
