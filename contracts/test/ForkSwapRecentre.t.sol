// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ArbitrumFork} from "./ForkBase.sol";
import {HelicoVault} from "../src/HelicoVault.sol";
import {Mandate, MandateLib, PoolKey} from "../src/Mandate.sol";
import {TickMath} from "../src/lib/TickMath.sol";

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @dev The ERC-721 half of the real PositionManager, which the vault's own interface does not
///      need and so does not declare.
interface IPositionNft {
    function setApprovalForAll(address operator, bool approved) external;
}

/// @notice The swap path, executed end to end against the real Uniswap v4 on Arbitrum One.
///
/// @dev This file exists because the swap cannot be proven anywhere else. `MockPoolManager`
///      refuses to model a price curve on purpose, so without this the lines that move the
///      money would run in no test at all — the same hole as a mock that cannot refuse
///      anything, with the mock replaced by nothing.
///
///      Nothing here is borrowed. The test funds an owner, mints its own position out of range
///      through the live PositionManager, and re-centres it, so it does not depend on a
///      stranger's position that may flip sides between runs, and it needs no archive node.
contract ForkSwapRecentreTest is ArbitrumFork {
    using MandateLib for PoolKey;

    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    uint256 constant Q96 = 2 ** 96;

    uint8 constant MINT_POSITION = 0x02;
    uint8 constant SETTLE_PAIR = 0x0d;

    HelicoVault vault;
    address admin = makeAddr("admin");
    address agent = makeAddr("agent");
    address owner = makeAddr("owner");

    /// @dev 100 whole `par`, enough to be a real position in a pool this deep without being a
    ///      size that would move the price by itself.
    uint256 constant PAR_IN = 100 ether;
    uint16 constant WIDTH_TICKS = 200;
    uint16 constant RETAIN_BPS = 5_000;

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

    /// @dev Liquidity funded by token1 alone, for a range that sits entirely below the price.
    function _liquidityForAmount1(uint160 sa, uint160 sb, uint256 amount1) internal pure returns (uint128) {
        if (sa > sb) (sa, sb) = (sb, sa);
        return uint128(Math.mulDiv(amount1, Q96, sb - sa));
    }

    /// @dev Mints a position whose whole range sits below the market, so it holds only token1 —
    ///      the shape the product exists to rescue and the one that cannot be re-centred
    ///      without a swap.
    function _mintOutOfRangePosition() internal returns (uint256 tokenId, int24 lower, int24 upper) {
        return _mintOutOfRangePosition(PAR_IN);
    }

    function _mintOutOfRangePosition(uint256 amount1)
        internal
        returns (uint256 tokenId, int24 lower, int24 upper)
    {
        int24 spacing = demoPool.tickSpacing;
        int24 tick = _tickOf(demoPool);

        upper = (tick / spacing) * spacing - spacing * 100;
        lower = upper - spacing * 20;

        uint128 liquidity = _liquidityForAmount1(
            TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), amount1
        );

        deal(demoPool.currency1, owner, amount1 * 2);
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
            minImprovementBps: 100,
            cooldownSeconds: 1 hours,
            maxLiquidity: type(uint128).max,
            expiry: uint64(block.timestamp + 30 days),
            minRetainedBps: RETAIN_BPS
        });
    }

    /// @notice The case the whole product exists for: a position that has drifted out of range,
    ///         holding one token, re-centred onto the market.
    function test_RecentresAnOutOfRangePositionThroughASwap() public {
        _fork();
        _setUpVault();

        (uint256 tokenId,,) = _mintOutOfRangePosition();
        uint128 liquidityBefore = POSITION_MANAGER.getPositionLiquidity(tokenId);
        assertGt(liquidityBefore, 0, "the position exists");
        assertFalse(_isInRange(tokenId, demoPool), "and it is out of range, which is the point");

        vm.prank(owner);
        vault.setMandate(tokenId, _mandate());

        int24 spacing = demoPool.tickSpacing;
        int24 tick = _tickOf(demoPool);
        // Upper edge just above the market, so most of the new range is funded by the token the
        // position already holds and the swap only has to cover the sliver above spot.
        int24 newUpper = (tick / spacing) * spacing + spacing;
        int24 newLower = newUpper - int24(uint24(WIDTH_TICKS));
        assertTrue(tick >= newLower && tick < newUpper, "the new range brackets the market");

        uint256 parAfterSwap = (PAR_IN * 85) / 100;
        uint128 toMint =
            _liquidityForAmount1(TickMath.getSqrtPriceAtTick(newLower), _sqrtPriceOf(demoPool), parAfterSwap);

        uint256 ownerEthBefore = owner.balance;

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
                zeroForOne: false, // sell the token1 it holds for the token0 the range needs
                amountIn: PAR_IN / 10,
                minAmountOut: 0,
                deadline: block.timestamp + 60
            })
        );

        // The position moved, and it moved onto the market.
        assertEq(POSITION_MANAGER.ownerOf(newTokenId), owner, "the new position belongs to the owner");
        assertTrue(_isInRange(newTokenId, demoPool), "and it is earning again");
        (int24 gotLower, int24 gotUpper) = _rangeOf(newTokenId);
        assertEq(gotLower, newLower);
        assertEq(gotUpper, newUpper);

        // Enough of it survived the round trip.
        uint128 retained = POSITION_MANAGER.getPositionLiquidity(newTokenId);
        assertGe(
            uint256(retained) * 10_000, uint256(liquidityBefore) * RETAIN_BPS, "cleared the retention floor"
        );

        // And the vault kept none of what passed through it.
        assertEq(address(vault).balance, 0, "no native left in the vault");
        assertEq(IERC20(demoPool.currency1).balanceOf(address(vault)), 0, "no token1 left in the vault");
        assertGe(owner.balance, ownerEthBefore, "leftovers went to the owner, not to the agent");
        assertEq(agent.balance, 0, "the agent gained nothing");
        assertEq(IERC20(demoPool.currency1).balanceOf(agent), 0, "the agent gained nothing");

        emit log_named_uint("liquidity before", liquidityBefore);
        emit log_named_uint("liquidity after", retained);
    }

    /// @notice The attack the design review found, run against the real curve.
    ///
    /// @dev The range is checked against the tick *before* the unlock, and the swap moves that
    ///      tick afterwards. An agent that swaps far more than the re-centre needs would push
    ///      the price out of the range it just had approved, and mint single-sided while every
    ///      post-condition still passed — the retention floor does not catch it, because a unit
    ///      of liquidity is cheapest exactly at the edge a manipulated price sits on.
    ///
    ///      What stops it is the price limit: it is the sqrt price at the edge of the committed
    ///      range, so the pool halts the swap there. This spends everything the burn returned,
    ///      the largest swap the vault will ever permit, and the position still lands inside
    ///      the band the user signed.
    /// @notice The attack the design review found, run against the real curve.
    ///
    /// @dev The range is checked against the tick *before* the unlock, and the swap moves that
    ///      tick afterwards. An agent that swaps far more than the re-centre needs would push
    ///      the price out of the range it just had approved, and mint single-sided while every
    ///      post-condition still passed — the retention floor does not catch it, because a unit
    ///      of liquidity is cheapest exactly at the edge a manipulated price sits on.
    ///
    ///      The swap size is derived from the pool's **live** active liquidity, not from a
    ///      number measured once. A fixed size stops being an attack the moment somebody adds
    ///      liquidity. A teammate ran the first version of this test against a pool three times
    ///      deeper than when it was written and the tick did not move at all, so it passed
    ///      while proving nothing.
    function test_AnOversizedSwapCannotPushThePriceOutOfTheCommittedRange() public {
        _fork();
        _setUpVault();

        int24 spacing = demoPool.tickSpacing;
        int24 tick = _tickOf(demoPool);
        (int24 newLower, int24 newUpper) = _rangeAboveTick(tick, spacing);

        // Enough token1 to carry the price five spacings past the range's upper edge at the
        // liquidity in the pool right now: amount1 = L * (sqrtTarget - sqrtNow) / 2**96.
        uint128 active = STATE_VIEW.getLiquidity(demoPool.hashPoolKey());
        uint160 sqrtNow = _sqrtPriceOf(demoPool);
        uint160 sqrtTarget = TickMath.getSqrtPriceAtTick(newUpper + spacing * 5);
        uint256 toCrossTheEdge = Math.mulDiv(active, sqrtTarget - sqrtNow, Q96);
        assertGt(toCrossTheEdge, 0, "the pool has liquidity to push against");

        // Mint with headroom, so the burn certainly returns more than the attack needs.
        (uint256 tokenId,,) = _mintOutOfRangePosition(toCrossTheEdge * 2);
        uint128 liquidityBefore = POSITION_MANAGER.getPositionLiquidity(tokenId);

        Mandate memory m = _mandate();
        m.rangeWidthTicks = 20;
        m.minRetainedBps = 0; // so the floor cannot be what rejects it, only the price guard
        vm.prank(owner);
        vault.setMandate(tokenId, m);

        // Re-read: minting the position above may itself have shifted the tick.
        tick = _tickOf(demoPool);
        (newLower, newUpper) = _rangeAboveTick(tick, spacing);

        vm.prank(agent);
        uint256 newTokenId = vault.recenter(
            HelicoVault.RecenterParams({
                owner: owner,
                tickLower: newLower,
                tickUpper: newUpper,
                liquidityToMint: 1,
                amount0Min: 0,
                amount1Min: 0,
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max,
                zeroForOne: false,
                amountIn: toCrossTheEdge,
                minAmountOut: 0,
                deadline: block.timestamp + 60
            })
        );

        int24 after_ = _tickOf(demoPool);

        // Both halves, and the first is the one that matters. Asserting only that the tick
        // ended inside the range is satisfied by a swap that never moved it at all — which is
        // how this test read as idle on a deeper pool. It has to have pushed, and been stopped.
        assertTrue(after_ > tick, "the swap actually moved the price");
        assertEq(after_, newUpper - 1, "and the pool halted on the last tick inside the range");
        assertTrue(_isInRange(newTokenId, demoPool), "so the position is still on the market");
        assertEq(POSITION_MANAGER.ownerOf(newTokenId), owner, "and it is still the owner's");

        // Everything the oversized swap bought still went to the owner, never to the agent.
        assertEq(address(vault).balance, 0, "the vault kept nothing");
        assertEq(IERC20(demoPool.currency1).balanceOf(address(vault)), 0, "the vault kept nothing");
        assertEq(agent.balance, 0, "the agent gained nothing");
        assertEq(IERC20(demoPool.currency1).balanceOf(agent), 0, "the agent gained nothing");

        emit log_named_uint("active liquidity", active);
        emit log_named_uint("input sized to cross the edge", toCrossTheEdge);
        emit log_named_int("tick before", tick);
        emit log_named_int("tick after the oversized swap", after_);
        emit log_named_uint("liquidity before", liquidityBefore);
    }

    /// @notice The range this test commits to: the spacing above `tick`, 20 ticks wide.
    ///
    /// @dev The extra spacing when the tick already sits on its bucket's last tick is not
    ///      cosmetic. The vault limits the swap to the sqrt price at the range's upper edge and
    ///      the pool halts on the last tick inside it, so if that tick is the one the price is
    ///      already on, the largest swap the vault permits moves nothing — and the test reads as
    ///      idle instead of as proof. One live tick in `spacing` lands there, which is how this
    ///      failed on one run and passed on the next against the same code. Reproduce the old
    ///      shape with `HELICO_FORK_BLOCK=502399995` (ETH/ARB at tick 94819).
    function _rangeAboveTick(int24 tick, int24 spacing) internal pure returns (int24 lower, int24 upper) {
        upper = (tick / spacing) * spacing + spacing;
        if (upper - tick < 2) upper += spacing;
        lower = upper - 20;
    }

    function _sqrtPriceOf(PoolKey memory key) internal view returns (uint160 sqrtPriceX96) {
        (sqrtPriceX96,,,) = STATE_VIEW.getSlot0(key.hashPoolKey());
    }

    /// @notice The agent asks for more liquidity than the price it actually got can fund.
    ///
    /// @dev This is the shape of #78, and it is not exotic: the enclave sizes `liquidityToMint`
    ///      from a model of the swap that assumes constant liquidity, and the real pool crosses
    ///      initialised ticks. On the rehearsal that found it the model was out by 16%, and the
    ///      whole re-centre reverted — position burned, swap done, nothing minted, for
    ///      arithmetic rather than for anything the user agreed to.
    ///
    ///      Asking for `type(uint128).max` is the same failure with the guesswork removed: no
    ///      price funds it, so if the vault mints what it was told to, this reverts. It has to
    ///      mint what it can afford instead.
    function test_MintsWhatItCanAffordWhenTheAgentAsksForMore() public {
        _fork();
        _setUpVault();

        (uint256 tokenId,,) = _mintOutOfRangePosition();
        uint128 liquidityBefore = POSITION_MANAGER.getPositionLiquidity(tokenId);

        vm.prank(owner);
        vault.setMandate(tokenId, _mandate());

        int24 spacing = demoPool.tickSpacing;
        int24 tick = _tickOf(demoPool);
        int24 newUpper = (tick / spacing) * spacing + spacing;
        int24 newLower = newUpper - int24(uint24(WIDTH_TICKS));

        vm.prank(agent);
        uint256 newTokenId = vault.recenter(
            HelicoVault.RecenterParams({
                owner: owner,
                tickLower: newLower,
                tickUpper: newUpper,
                // No price on earth funds this out of one burned position.
                liquidityToMint: type(uint128).max,
                amount0Min: 0,
                amount1Min: 0,
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max,
                zeroForOne: false,
                amountIn: PAR_IN / 10,
                minAmountOut: 0,
                deadline: block.timestamp + 60
            })
        );

        uint128 minted = POSITION_MANAGER.getPositionLiquidity(newTokenId);

        assertGt(minted, 0, "it minted something");
        assertLt(minted, type(uint128).max, "and less than it was asked for");
        assertTrue(_isInRange(newTokenId, demoPool), "onto the market");
        assertEq(POSITION_MANAGER.ownerOf(newTokenId), owner, "for the owner");

        // The cap is not a licence to mint dust: the mandate's floor still decides.
        assertGe(uint256(minted) * 10_000, uint256(liquidityBefore) * RETAIN_BPS, "cleared the floor");

        // And it spent what it had rather than leaving the difference idle in the wallet.
        assertEq(address(vault).balance, 0, "no native left in the vault");
        assertEq(IERC20(demoPool.currency1).balanceOf(address(vault)), 0, "no token1 left");

        emit log_named_uint("asked for", type(uint128).max);
        emit log_named_uint("minted", minted);
    }

    /// @notice The agent's predicted maxima are below what the swap actually returned.
    ///
    /// @dev The other half of #78, and the one #80 left behind: the vault stopped trusting the
    ///      enclave's `liquidityToMint` but still passed the enclave's guess about its own
    ///      balances to v4 as the mint's ceiling. A swap that returns *more* of the binding
    ///      token than predicted then reverts on `MaximumAmountExceeded` while the vault is
    ///      holding plenty.
    ///
    ///      One wei is that failure with the guesswork removed. No mint fits under it, so if
    ///      the vault still honours the agent's ceiling this reverts; it has to use what it
    ///      actually holds. Nothing is lost by that — the vault cannot spend more than it
    ///      transferred in, and `_settleUp` asserts the rest reaches the owner, both of which
    ///      the assertions below check.
    function test_TheAgentsMaximaCannotBlockAMintTheVaultCanPayFor() public {
        _fork();
        _setUpVault();

        (uint256 tokenId,,) = _mintOutOfRangePosition();
        uint128 liquidityBefore = POSITION_MANAGER.getPositionLiquidity(tokenId);

        vm.prank(owner);
        vault.setMandate(tokenId, _mandate());

        int24 spacing = demoPool.tickSpacing;
        int24 tick = _tickOf(demoPool);
        int24 newUpper = (tick / spacing) * spacing + spacing;
        int24 newLower = newUpper - int24(uint24(WIDTH_TICKS));

        uint256 parAfterSwap = (PAR_IN * 85) / 100;
        uint128 toMint =
            _liquidityForAmount1(TickMath.getSqrtPriceAtTick(newLower), _sqrtPriceOf(demoPool), parAfterSwap);

        uint256 ownerEthBefore = owner.balance;

        vm.prank(agent);
        uint256 newTokenId = vault.recenter(
            HelicoVault.RecenterParams({
                owner: owner,
                tickLower: newLower,
                tickUpper: newUpper,
                liquidityToMint: toMint,
                amount0Min: 0,
                amount1Min: 0,
                // A ceiling no mint on any pool fits under.
                amount0Max: 1,
                amount1Max: 1,
                zeroForOne: false,
                amountIn: PAR_IN / 10,
                minAmountOut: 0,
                deadline: block.timestamp + 60
            })
        );

        assertTrue(_isInRange(newTokenId, demoPool), "it re-centred anyway");
        assertEq(POSITION_MANAGER.ownerOf(newTokenId), owner, "for the owner");
        assertGe(
            uint256(POSITION_MANAGER.getPositionLiquidity(newTokenId)) * 10_000,
            uint256(liquidityBefore) * RETAIN_BPS,
            "and still cleared the floor"
        );

        // Dropping the ceiling did not let the vault keep or misroute anything.
        assertEq(address(vault).balance, 0, "no native left in the vault");
        assertEq(IERC20(demoPool.currency1).balanceOf(address(vault)), 0, "no token1 left");
        assertGe(owner.balance, ownerEthBefore, "leftovers went to the owner");
        assertEq(agent.balance, 0, "the agent gained nothing");
    }
}
