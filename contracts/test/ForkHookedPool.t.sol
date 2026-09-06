// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MainnetFork} from "./ForkBase.sol";
import {HelicoVault} from "../src/HelicoVault.sol";
import {Mandate, MandateLib, PoolKey} from "../src/Mandate.sol";
import {IPoolManager} from "../src/IPoolManager.sol";
import {LiquidityAmounts} from "../src/lib/LiquidityAmounts.sol";
import {TickMath} from "../src/lib/TickMath.sol";

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IPositionNft {
    function setApprovalForAll(address operator, bool approved) external;
}

/// @dev The two callbacks this test asserts were reached. Declared here rather than imported
///      because the vault has no reason to know a hook interface exists.
interface IHookCallbacks {
    struct ModifyLiquidityParams {
        int24 tickLower;
        int24 tickUpper;
        int256 liquidityDelta;
        bytes32 salt;
    }

    function beforeAddLiquidity(address, PoolKey memory, ModifyLiquidityParams memory, bytes calldata)
        external
        returns (bytes4);
    function beforeRemoveLiquidity(address, PoolKey memory, ModifyLiquidityParams memory, bytes calldata)
        external
        returns (bytes4);
    function beforeSwap(address, PoolKey memory, IPoolManager.SwapParams memory, bytes calldata)
        external
        returns (bytes4, int256, uint24);
}

/// @notice The vault against a pool whose hook somebody else wrote and deploys today.
///
/// @dev **The claim being tested.** Helico works in pools that have hooks. Every other fork test
///      in this repository runs against a hook-less pool, where `PoolKey.hooks` is the zero
///      address and no callback exists to run — so none of them can support the claim, however
///      green they are.
///
///      **Why a real hook and not one of ours.** A hook we wrote would prove our hook and our
///      vault agree. Angstrom's `0x0000000aa232…` was deployed by someone else, audited by
///      someone else, and is carrying a live USDC/WETH market; if the vault's assumptions about
///      what a hook may do are wrong, this is where that shows.
///
///      **What was verified before this file was written**, by calling the hook directly in the
///      PoolManager's shoes from an unrelated address: `beforeAddLiquidity` and
///      `beforeRemoveLiquidity` accept, `beforeSwap` reverts `CannotSwapWhileLocked()`. So the
///      re-centre proven here is the swap-free one, and the swap being refused is proven too,
///      as its own test, rather than left as a shape nobody exercised.
contract ForkHookedPoolTest is MainnetFork {
    using MandateLib for PoolKey;

    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    uint8 constant MINT_POSITION = 0x02;
    uint8 constant SETTLE_PAIR = 0x0d;

    /// @dev Angstrom's refusal, `bytes4(keccak256("CannotSwapWhileLocked()"))`. Read off the
    ///      chain, not guessed: the probe returned this selector and openchain names it.
    bytes4 constant CANNOT_SWAP_WHILE_LOCKED = 0x1e8107a0;

    /// @dev v4-core does not let a hook's revert through as it was thrown. `CustomRevert`
    ///      re-wraps it as `WrappedError(address target, bytes4 selector, bytes reason, bytes
    ///      details)` — which callback was being called, on which hook, and why it failed.
    ///      Asserting the wrapper rather than a bare `vm.expectRevert()` is the difference
    ///      between proving the hook refused this swap and proving something, somewhere, threw.
    bytes4 constant WRAPPED_ERROR = 0x90bfb865;
    bytes4 constant HOOK_CALL_FAILED = 0xa9e35b2f;

    HelicoVault vault;
    address admin = makeAddr("admin");
    address agent = makeAddr("agent");
    address owner = makeAddr("owner");

    /// @dev Both ranges are this wide, so a re-centre is a shift rather than a resize and the
    ///      mandate's one exact width covers both.
    uint16 constant WIDTH_TICKS = 100;

    /// @dev Sized far below what the burn returns, so `SwapExceedsWithdrawn` cannot be what
    ///      rejects this and the hook's refusal is the only thing left to fail on.
    uint256 constant SWAP_IN = 0.001 ether;

    uint256 constant USDC_IN = 200_000e6;
    uint256 constant WETH_IN = 100 ether;

    function _setUpVault() internal {
        HelicoVault impl = new HelicoVault();
        bytes memory init = abi.encodeCall(
            HelicoVault.initialize,
            (admin, address(POSITION_MANAGER), address(STATE_VIEW), address(POOL_MANAGER))
        );
        vault = HelicoVault(payable(address(new ERC1967Proxy(address(impl), init))));
        // Read the role first: `vm.prank` applies to the next call, and `AGENT_ROLE()` is one.
        bytes32 role = vault.AGENT_ROLE();
        vm.prank(admin);
        vault.grantRole(role, agent);
    }

    /// @dev The range the position starts in and the range it is moved to.
    ///
    ///      Three constraints hold at once, and they are the vault's, not this test's. Both
    ///      ranges must bracket the live tick, or the mint is refused as off-market. Both must be
    ///      exactly `WIDTH_TICKS` wide, because a mandate commits to one width. And the new range
    ///      must sit *closer* to the tick than the old one: `gapNext >= gapNow` reverts even when
    ///      `minImprovementBps` is zero, because a move that does not improve centring is not a
    ///      re-centre.
    ///
    ///      So the position starts badly centred, with the price near its upper edge, and moves
    ///      to a range centred on the price. Written against `base` rather than the tick itself,
    ///      the arithmetic holds for every value of `tick % spacing`: the old gap is always 40-49
    ///      ticks and the new one 0-9. A fixture read from a live pool has as many states as the
    ///      tick has residues, and one of them failing is a coin flip, not a flake.
    function _ranges()
        internal
        view
        returns (int24 oldLower, int24 oldUpper, int24 newLower, int24 newUpper)
    {
        int24 spacing = demoPool.tickSpacing;
        int24 base = (_tickOf(demoPool) / spacing) * spacing;
        oldLower = base - spacing * 9;
        oldUpper = oldLower + int24(uint24(WIDTH_TICKS)); // [base-90, base+10)
        newLower = base - spacing * 5;
        newUpper = newLower + int24(uint24(WIDTH_TICKS)); // [base-50, base+50)
    }

    /// @dev Mints a position that straddles the market, so burning it returns both tokens and a
    ///      new range can be funded without a swap.
    function _mintInRangePosition(int24 lower, int24 upper) internal returns (uint256 tokenId) {
        (uint160 sqrtPriceX96,,,) = STATE_VIEW.getSlot0(demoPool.hashPoolKey());
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(lower),
            TickMath.getSqrtPriceAtTick(upper),
            USDC_IN,
            WETH_IN
        );
        require(liquidity > 0, "fixture: no liquidity affordable");

        deal(demoPool.currency0, owner, USDC_IN * 2);
        deal(demoPool.currency1, owner, WETH_IN * 2);
        tokenId = POSITION_MANAGER.nextTokenId();

        vm.startPrank(owner);
        IERC20(demoPool.currency0).approve(PERMIT2, type(uint256).max);
        IERC20(demoPool.currency1).approve(PERMIT2, type(uint256).max);
        IPermit2(PERMIT2)
            .approve(
                demoPool.currency0,
                address(POSITION_MANAGER),
                type(uint160).max,
                uint48(block.timestamp + 1 days)
            );
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
            cooldownSeconds: 1 hours, // the vault refuses a mandate with none; nothing has moved yet
            maxLiquidity: type(uint128).max,
            expiry: uint64(block.timestamp + 30 days),
            // Zero on purpose. What is on trial here is whether a hook lets the vault through,
            // and a retention floor rejecting the move would answer a different question.
            minRetainedBps: 0
        });
    }

    function _recenterParams(int24 lower, int24 upper, bool zeroForOne, uint256 amountIn)
        internal
        view
        returns (HelicoVault.RecenterParams memory)
    {
        return HelicoVault.RecenterParams({
            owner: owner,
            tickLower: lower,
            tickUpper: upper,
            liquidityToMint: type(uint128).max, // the vault caps this to what the burn affords
            amount0Min: 0,
            amount1Min: 0,
            amount0Max: type(uint128).max,
            amount1Max: type(uint128).max,
            zeroForOne: zeroForOne,
            amountIn: amountIn,
            minAmountOut: 0,
            deadline: block.timestamp + 60
        });
    }

    /// @notice A position moved inside a pool that has a hook, with the hook's callbacks reached.
    ///
    /// @dev The assertion that matters is `expectCall`, not the tick arithmetic. Checking only
    ///      that the position moved would pass identically against a hook-less pool, which is
    ///      what every other fork test here already does; it would be a test whose evidence is
    ///      satisfiable without the thing it claims ever happening.
    function test_RecentresInsideAPoolWhoseHookSomeoneElseWrote() public {
        _fork();
        _setUpVault();

        (int24 oldLower, int24 oldUpper, int24 newLower, int24 newUpper) = _ranges();
        assertTrue(demoPool.hooks != address(0), "the fixture pool has a hook at all");

        uint256 tokenId = _mintInRangePosition(oldLower, oldUpper);
        uint128 liquidityBefore = POSITION_MANAGER.getPositionLiquidity(tokenId);
        assertGt(liquidityBefore, 0, "the position exists");
        assertTrue(_isInRange(tokenId, demoPool), "and the price is inside it");

        vm.prank(owner);
        vault.setMandate(tokenId, _mandate());

        // Only true if the pool manager actually invoked the hook, twice, for this action.
        vm.expectCall(demoPool.hooks, abi.encodeWithSelector(IHookCallbacks.beforeRemoveLiquidity.selector));
        vm.expectCall(demoPool.hooks, abi.encodeWithSelector(IHookCallbacks.beforeAddLiquidity.selector));

        vm.prank(agent);
        uint256 newTokenId = vault.recenter(_recenterParams(newLower, newUpper, false, 0));

        assertEq(POSITION_MANAGER.ownerOf(newTokenId), owner, "the new position belongs to the owner");
        (int24 gotLower, int24 gotUpper) = _rangeOf(newTokenId);
        assertEq(gotLower, newLower, "moved to the committed lower tick");
        assertEq(gotUpper, newUpper, "moved to the committed upper tick");
        assertTrue(gotLower != oldLower, "and it is not the range it started in");
        assertTrue(_isInRange(newTokenId, demoPool), "the price is inside the new range");
        assertGt(POSITION_MANAGER.getPositionLiquidity(newTokenId), 0, "with liquidity in it");

        assertEq(IERC20(demoPool.currency0).balanceOf(address(vault)), 0, "the vault kept nothing");
        assertEq(IERC20(demoPool.currency1).balanceOf(address(vault)), 0, "the vault kept nothing");
        assertEq(IERC20(demoPool.currency0).balanceOf(agent), 0, "the agent gained nothing");
        assertEq(IERC20(demoPool.currency1).balanceOf(agent), 0, "the agent gained nothing");

        emit log_named_uint("liquidity before", liquidityBefore);
        emit log_named_uint("liquidity after", POSITION_MANAGER.getPositionLiquidity(newTokenId));
    }

    /// @notice When the hook refuses the swap, the whole re-centre is undone.
    ///
    /// @dev Angstrom opens its pool only inside its own auction bundle, so any other swap is
    ///      refused. The vault does the burn first, so a naive implementation could leave the
    ///      owner with a burnt position and no new one. It does not: the revert unwinds the
    ///      unlock, and the position the owner started with is still theirs, still that size.
    function test_AHookRefusingTheSwapUndoesTheWholeRecentre() public {
        _fork();
        _setUpVault();

        (int24 oldLower, int24 oldUpper, int24 newLower, int24 newUpper) = _ranges();
        uint256 tokenId = _mintInRangePosition(oldLower, oldUpper);
        uint128 liquidityBefore = POSITION_MANAGER.getPositionLiquidity(tokenId);

        vm.prank(owner);
        vault.setMandate(tokenId, _mandate());

        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(
                WRAPPED_ERROR,
                demoPool.hooks,
                IHookCallbacks.beforeSwap.selector,
                abi.encodePacked(CANNOT_SWAP_WHILE_LOCKED),
                abi.encodePacked(HOOK_CALL_FAILED)
            )
        );
        vault.recenter(_recenterParams(newLower, newUpper, false, SWAP_IN));

        assertEq(POSITION_MANAGER.ownerOf(tokenId), owner, "the owner still has the position");
        assertEq(POSITION_MANAGER.getPositionLiquidity(tokenId), liquidityBefore, "at its original size");
        (int24 stillLower, int24 stillUpper) = _rangeOf(tokenId);
        assertEq(stillLower, oldLower, "in its original range");
        assertEq(stillUpper, oldUpper, "in its original range");
    }
}
