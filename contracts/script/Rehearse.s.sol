// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {HelicoVault} from "../src/HelicoVault.sol";
import {Mandate, MandateLib, PoolKey} from "../src/Mandate.sol";
import {IPositionManager} from "../src/IPositionManager.sol";
import {IStateView} from "../src/IStateView.sol";
import {TickMath} from "../src/lib/TickMath.sol";

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IPositionNft {
    function setApprovalForAll(address operator, bool approved) external;
}

/// @notice Gives a rehearsal something to rescue: mints an out-of-range position for the
///         broadcaster on the demo pool, approves the vault, and commits a mandate.
///
/// @dev This is not part of the product. It exists so `apps/cre/rehearse.sh` can put a fork
///      into the one state the workflow is interesting in — a position holding a single token,
///      below the market, which cannot fund a two-sided range without a swap.
///
///      It mirrors `ForkSwapRecentreTest._mintOutOfRangePosition` and `_mandate` deliberately.
///      If the two ever disagree, the rehearsal stops being evidence for what the fork tests
///      prove, which is the only reason it is worth running at all. The token balance is
///      funded outside, by the script that calls this.
///
///        VAULT=0x… EXPIRY=1791244800 forge script script/Rehearse.s.sol:Rehearse \
///          --rpc-url http://127.0.0.1:8546 --broadcast
contract Rehearse is Script {
    using MandateLib for PoolKey;
    using MandateLib for Mandate;

    IPositionManager constant POSITION_MANAGER = IPositionManager(0xd88F38F930b7952f2DB2432Cb002E7abbF3dD869);
    IStateView constant STATE_VIEW = IStateView(0x76Fd297e2D437cd7f76d50F01AfE6160f86e9990);
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    uint256 constant Q96 = 2 ** 96;
    uint8 constant MINT_POSITION = 0x02;
    uint8 constant SETTLE_PAIR = 0x0d;

    struct Plan {
        int24 tick;
        int24 lower;
        int24 upper;
        uint128 liquidity;
        uint256 tokenId;
    }

    function _pool() internal pure returns (PoolKey memory) {
        return PoolKey({
            currency0: address(0),
            currency1: 0x912CE59144191C1204E64559FE8253a0e49E6548,
            fee: 500,
            tickSpacing: 10,
            hooks: address(0)
        });
    }

    function _plan(PoolKey memory pool) internal view returns (Plan memory p) {
        (, p.tick,,) = STATE_VIEW.getSlot0(pool.hashPoolKey());
        p.upper = (p.tick / 10) * 10 - 10 * 100;
        p.lower = p.upper - 10 * 20;
        uint160 sa = TickMath.getSqrtPriceAtTick(p.lower);
        uint160 sb = TickMath.getSqrtPriceAtTick(p.upper);
        p.liquidity = uint128(Math.mulDiv(100 ether, Q96, sb - sa));
        p.tokenId = POSITION_MANAGER.nextTokenId();
    }

    function _mint(PoolKey memory pool, Plan memory p, address owner) internal {
        IERC20(pool.currency1).approve(PERMIT2, type(uint256).max);
        IPermit2(PERMIT2)
            .approve(
                pool.currency1, address(POSITION_MANAGER), type(uint160).max, uint48(block.timestamp + 1 days)
            );
        bytes memory actions = abi.encodePacked(MINT_POSITION, SETTLE_PAIR);
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            pool,
            p.lower,
            p.upper,
            uint256(p.liquidity),
            type(uint128).max,
            type(uint128).max,
            owner,
            bytes("")
        );
        params[1] = abi.encode(pool.currency0, pool.currency1);
        POSITION_MANAGER.modifyLiquidities(abi.encode(actions, params), block.timestamp + 600);
    }

    function _mandate(PoolKey memory pool, uint64 expiry) internal pure returns (Mandate memory) {
        return Mandate({
            poolId: pool.hashPoolKey(),
            rangeWidthTicks: 200,
            minImprovementBps: 100,
            cooldownSeconds: 3600,
            maxLiquidity: type(uint128).max,
            expiry: expiry,
            minRetainedBps: 5000
        });
    }

    function run() external {
        HelicoVault vault = HelicoVault(payable(vm.envAddress("VAULT")));
        uint64 expiry = uint64(vm.envUint("EXPIRY"));
        PoolKey memory pool = _pool();
        Plan memory p = _plan(pool);
        Mandate memory m = _mandate(pool, expiry);

        vm.startBroadcast();
        _mint(pool, p, msg.sender);
        IPositionNft(address(POSITION_MANAGER)).setApprovalForAll(address(vault), true);
        vault.setMandate(p.tokenId, m);
        vm.stopBroadcast();

        console.log("tick now      ", p.tick);
        console.log("token id      ", p.tokenId);
        console.log("range lower   ", p.lower);
        console.log("range upper   ", p.upper);
        console.log("liquidity     ", p.liquidity);
        console.logBytes32(m.hash());
    }
}
