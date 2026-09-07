// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ArbitrumHookedFork} from "./ForkBase.sol";
import {HelicoVault} from "../src/HelicoVault.sol";
import {IPoolManager} from "../src/IPoolManager.sol";
import {Mandate, MandateLib, PoolKey} from "../src/Mandate.sol";
import {TickMath} from "../src/lib/TickMath.sol";

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IPositionNft {
    function setApprovalForAll(address operator, bool approved) external;
}

/// @dev The two callbacks this hook registers, and the only two it can be asked for.
interface IHookCallbacks {
    function beforeSwap(address, PoolKey memory, IPoolManager.SwapParams memory, bytes calldata)
        external
        returns (bytes4, int256, uint24);
    function afterSwap(address, PoolKey memory, IPoolManager.SwapParams memory, int256, bytes calldata)
        external
        returns (bytes4, int128);
}

/// @notice The swap half of "Helico works in pools that have hooks", on the chain it deploys to.
///
/// @dev `ForkHookedPool.t.sol` proves the liquidity half against Angstrom on Ethereum, and proves
///      it there because Angstrom **refuses** a third-party swap: the pool is open only inside its
///      own auction bundle. That leaves the swap callbacks unproven, and leaves the whole hook
///      claim standing on a chain the product does not run on.
///
///      This closes both. `LimitOrderHook` on Arbitrum One registers `beforeSwap` and `afterSwap`
///      and nothing else, so the burn and the mint pass it untouched and the swap goes straight
///      through it — the exact complement of the Angstrom fixture.
///
///      **What was checked before this file existed**, because a hook's declared flags say which
///      callbacks run and nothing about what they do:
///
///        - the permission bits, decoded from the address: `0x00c0`, `beforeSwap` + `afterSwap`
///        - `beforeSwap` called in the PoolManager's shoes from an unrelated address: accepted
///        - a real 0.01 ETH swap through the live pool inside `unlock`: 24.899864 USDC out, and
///          the price it implies — $2,489.99 — agrees with two independent readings taken the
///          same hour
///
///      That last one mattered: this hook's `afterSwap` delegates to a `LimitOrderManager`, and an
///      isolated call to `beforeSwap` would not have exercised it.
contract ForkHookedSwapArbitrumTest is ArbitrumHookedFork {
    using MandateLib for PoolKey;

    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    uint256 constant Q96 = 2 ** 96;

    uint8 constant MINT_POSITION = 0x02;
    uint8 constant SETTLE_PAIR = 0x0d;

    HelicoVault vault;
    address admin = makeAddr("admin");
    address agent = makeAddr("agent");
    address owner = makeAddr("owner");

    /// @dev USDC, six decimals. Large enough to be a real position in a pool this thin without
    ///      being a size that moves the price on the way in.
    uint256 constant USDC_IN = 20_000e6;
    uint16 constant WIDTH_TICKS = 100;

    function _setUpVault() internal {
        HelicoVault impl = new HelicoVault();
        bytes memory init = abi.encodeCall(
            HelicoVault.initialize,
            (admin, address(POSITION_MANAGER), address(STATE_VIEW), address(POOL_MANAGER))
        );
        vault = HelicoVault(payable(address(new ERC1967Proxy(address(impl), init))));
        bytes32 role = vault.AGENT_ROLE();
        vm.prank(admin);
        vault.grantRole(role, agent);
    }

    function _sqrtPriceOf() internal view returns (uint160 p) {
        (p,,,) = STATE_VIEW.getSlot0(demoPool.hashPoolKey());
    }

    /// @dev Liquidity a range entirely below the market can be funded with, token1 alone.
    function _liquidityForAmount1(uint160 sa, uint160 sb, uint256 amount1) internal pure returns (uint128) {
        if (sa > sb) (sa, sb) = (sb, sa);
        return uint128(Math.mulDiv(amount1, Q96, sb - sa));
    }

    /// @dev A position whose whole range sits below the market, so it holds only USDC — the shape
    ///      the product exists to rescue, and the one that cannot be re-centred without a swap.
    ///      Funding it from token1 alone also keeps native ETH out of the mint, which is the
    ///      position manager's fiddliest path and not what this test is about.
    function _mintBelowMarket() internal returns (uint256 tokenId, int24 lower, int24 upper) {
        int24 spacing = demoPool.tickSpacing;
        int24 tick = _tickOf(demoPool);

        upper = (tick / spacing) * spacing - spacing * 20;
        lower = upper - int24(uint24(WIDTH_TICKS));

        uint128 liquidity = _liquidityForAmount1(
            TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), USDC_IN
        );
        require(liquidity > 0, "fixture: nothing affordable");

        deal(demoPool.currency1, owner, USDC_IN * 2);
        tokenId = POSITION_MANAGER.nextTokenId();

        vm.startPrank(owner);
        IERC20(demoPool.currency1).approve(PERMIT2, type(uint256).max);
        IPermit2(PERMIT2)
            .approve(
                demoPool.currency1,
                address(POSITION_MANAGER),
                type(uint160).max,
                uint48(block.timestamp + 1 days)
            );

        bytes memory actions = abi.encodePacked(MINT_POSITION, SETTLE_PAIR);
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            demoPool, lower, upper, uint256(liquidity), type(uint128).max, type(uint128).max, owner, bytes("")
        );
        params[1] = abi.encode(demoPool.currency0, demoPool.currency1);
        POSITION_MANAGER.modifyLiquidities(abi.encode(actions, params), block.timestamp + 60);

        IPositionNft(address(POSITION_MANAGER)).setApprovalForAll(address(vault), true);
        vm.stopPrank();
    }

    function _mandate() internal view returns (Mandate memory) {
        return Mandate({
            poolId: demoPool.hashPoolKey(),
            rangeWidthTicks: WIDTH_TICKS,
            minImprovementBps: 0,
            cooldownSeconds: 1 hours,
            maxLiquidity: type(uint128).max,
            expiry: uint64(block.timestamp + 30 days),
            // Zero on purpose: what is on trial is whether a hook lets the swap through, and a
            // retention floor rejecting the move would answer a different question.
            minRetainedBps: 0
        });
    }

    /// @notice A position out of range, re-centred through a swap that runs the pool's hook.
    ///
    /// @dev The load-bearing assertions are the two `expectCall`s. Asserting only that the
    ///      position moved would pass identically against a hook-less pool — which is what every
    ///      other Arbitrum fork test in this repository already does.
    function test_RecentresThroughASwapThatRunsTheHook() public {
        _fork();
        _setUpVault();

        assertTrue(demoPool.hooks != address(0), "the fixture pool has a hook at all");

        (uint256 tokenId,,) = _mintBelowMarket();
        uint128 liquidityBefore = POSITION_MANAGER.getPositionLiquidity(tokenId);
        assertGt(liquidityBefore, 0, "the position exists");
        assertFalse(_isInRange(tokenId, demoPool), "and it is out of range, which is the point");

        vm.prank(owner);
        vault.setMandate(tokenId, _mandate());

        int24 spacing = demoPool.tickSpacing;
        int24 tick = _tickOf(demoPool);
        // Upper edge just above the market, so most of the new range is funded by the USDC the
        // position already holds and the swap only has to cover the sliver above spot.
        int24 newUpper = (tick / spacing) * spacing + spacing;
        int24 newLower = newUpper - int24(uint24(WIDTH_TICKS));
        assertTrue(tick >= newLower && tick < newUpper, "the new range brackets the market");

        uint256 usdcAfterBurn = (USDC_IN * 85) / 100;
        uint128 toMint =
            _liquidityForAmount1(TickMath.getSqrtPriceAtTick(newLower), _sqrtPriceOf(), usdcAfterBurn);

        // Only true if the pool manager reached the hook. Both of them, on one swap.
        vm.expectCall(demoPool.hooks, abi.encodeWithSelector(IHookCallbacks.beforeSwap.selector));
        vm.expectCall(demoPool.hooks, abi.encodeWithSelector(IHookCallbacks.afterSwap.selector));

        vm.prank(agent);
        uint256 newTokenId = vault.recenter(
            HelicoVault.RecenterParams({
                owner: owner,
                tickLower: newLower,
                tickUpper: newUpper,
                liquidityToMint: toMint,
                amount0Min: 0,
                amount1Min: 0,
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max,
                zeroForOne: false, // sell the USDC it holds for the ETH the new range needs
                amountIn: USDC_IN / 10,
                minAmountOut: 0,
                deadline: block.timestamp + 60
            })
        );

        assertEq(POSITION_MANAGER.ownerOf(newTokenId), owner, "the new position belongs to the owner");
        assertTrue(_isInRange(newTokenId, demoPool), "and it is earning again");
        (int24 gotLower, int24 gotUpper) = _rangeOf(newTokenId);
        assertEq(gotLower, newLower, "moved to the committed lower tick");
        assertEq(gotUpper, newUpper, "moved to the committed upper tick");
        assertGt(POSITION_MANAGER.getPositionLiquidity(newTokenId), 0, "with liquidity in it");

        // Everything the swap bought went to the owner, never to the agent.
        assertEq(address(vault).balance, 0, "the vault kept nothing");
        assertEq(IERC20(demoPool.currency1).balanceOf(address(vault)), 0, "the vault kept nothing");
        assertEq(agent.balance, 0, "the agent gained nothing");
        assertEq(IERC20(demoPool.currency1).balanceOf(agent), 0, "the agent gained nothing");

        emit log_named_uint("liquidity before", liquidityBefore);
        emit log_named_uint("liquidity after", POSITION_MANAGER.getPositionLiquidity(newTokenId));
    }
}
