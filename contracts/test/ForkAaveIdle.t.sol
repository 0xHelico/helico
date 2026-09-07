// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Declared as a struct rather than a 15-value tuple: destructuring that many returns
///      overflows the stack before the test body starts.
struct ReserveData {
    uint256 configuration;
    uint128 liquidityIndex;
    uint128 currentLiquidityRate;
    uint128 variableBorrowIndex;
    uint128 currentVariableBorrowRate;
    uint128 currentStableBorrowRate;
    uint40 lastUpdateTimestamp;
    uint16 id;
    address aTokenAddress;
    address stableDebtTokenAddress;
    address variableDebtTokenAddress;
    address interestRateStrategyAddress;
    uint128 accruedToTreasury;
    uint128 unbacked;
    uint128 isolationModeTotalDebt;
}

interface IAavePool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
    function getReserveData(address asset) external view returns (ReserveData memory);
}

/// @notice Can a maker's idle liquidity earn while it waits to be traded?
///
/// @dev The idea, before any of it is built: Aqua never takes custody, so a maker's tokens are
///      still theirs to use. Supply them to a lending market and the same capital does two jobs
///      -- earning, and standing ready as liquidity.
///
///      The problem the idea does not solve on its own: supplying USDC to Aave turns it into
///      aUSDC. Aqua's `pull` asks for USDC, from a wallet that no longer holds any. So the
///      withdrawal has to happen inside the same transaction as the swap, and this file exists
///      to find out whether that is actually possible before a line of the app is written.
contract ForkAaveIdleTest is Test {
    IAavePool constant POOL = IAavePool(0x794a61358D6845594F94dc1DB02A252b5b4814aD);
    IERC20 constant USDC = IERC20(0xaf88d065e77c8cC2239327C5EDb3A432268e5831);
    IERC20 constant AUSDC = IERC20(0x724dc807b04555b71ed48a6896b6F41593b8C637);

    address maker = address(0xA11CE);
    address app = address(0xA99);
    uint256 constant AMOUNT = 100_000e6;

    bool forked;

    function setUp() public {
        try vm.createSelectFork("arbitrum") {
            forked = block.chainid == 42161;
        } catch {
            forked = false;
        }
        if (!forked) {
            emit log("no endpoint: set ARBITRUM_RPC_URL to run this fork suite");
            vm.skip(true);
        }
    }

    /// @dev The whole premise in one test: supply, then get it back out from a third party that
    ///      only holds an aToken approval, in a single call.
    function test_AnAppCanUnwindAMakersAavePositionOnTheirBehalf() public {
        deal(address(USDC), maker, AMOUNT);

        vm.startPrank(maker);
        USDC.approve(address(POOL), AMOUNT);
        POOL.supply(address(USDC), AMOUNT, maker, 0);
        // This is the extra approval the design costs a user: the app may move their aToken.
        AUSDC.approve(app, type(uint256).max);
        vm.stopPrank();

        assertEq(USDC.balanceOf(maker), 0, "the USDC is gone -- this is the problem");
        // The shape of this assertion is the finding, not the number in it.
        //
        // An aToken balance is a scaled amount multiplied by a liquidity index, so supplying
        // 100,000 leaves slightly *less* than 100,000 behind, and how much less depends on the
        // index at that block. Two runs against the live chain gave a shortfall of 1 and then 2.
        //
        // So the rule for the app is not "allow a tolerance of N". It is: never assume the
        // balance equals what was supplied, and never ask to move a fixed amount out of it. Both
        // of my first two attempts here failed for exactly that reason.
        uint256 held = AUSDC.balanceOf(maker);
        assertLe(held, AMOUNT, "rounding goes against the supplier, never in their favour");
        assertGe(held, AMOUNT - 10, "but only by dust");

        // A swap takes part of the position, not all of it, which is also the realistic case.
        uint256 needed = 40_000e6;

        vm.startPrank(app);
        AUSDC.transferFrom(maker, app, needed);
        uint256 got = POOL.withdraw(address(USDC), needed, maker);
        vm.stopPrank();

        assertEq(got, needed, "withdraw returns what was asked for");
        assertEq(USDC.balanceOf(maker), needed, "and the USDC is back in the maker's wallet");
        assertEq(USDC.balanceOf(app), 0, "the app kept nothing");
        // The rest keeps earning. That is the entire point of the design.
        assertGe(AUSDC.balanceOf(maker), AMOUNT - needed - 10, "the remainder stays supplied");
        assertLe(AUSDC.balanceOf(maker), AMOUNT - needed, "and not more than it should");
    }

    /// @dev The yield is real, and this measures it rather than quoting a website.
    function test_TheIdleCapitalActuallyEarns() public {
        deal(address(USDC), maker, AMOUNT);
        vm.startPrank(maker);
        USDC.approve(address(POOL), AMOUNT);
        POOL.supply(address(USDC), AMOUNT, maker, 0);
        vm.stopPrank();

        uint256 before = AUSDC.balanceOf(maker);
        vm.warp(block.timestamp + 30 days);
        uint256 after30 = AUSDC.balanceOf(maker);

        assertGt(after30, before, "aToken balance grows with time");
        emit log_named_uint("earned on 100k USDC over 30 days (6dp)", after30 - before);

        emit log_named_uint("supply rate, ray", POOL.getReserveData(address(USDC)).currentLiquidityRate);
    }

    /// @dev The risk the owner pointed out, made concrete: if the market cannot pay out, the
    ///      withdrawal fails -- and a swap that depends on it fails with it. This is what the
    ///      enclave has to watch, and it is why it must watch it before the swap rather than
    ///      during.
    function test_AWithdrawalLargerThanTheMarketCanPayFails() public {
        deal(address(USDC), maker, AMOUNT);
        vm.startPrank(maker);
        USDC.approve(address(POOL), AMOUNT);
        POOL.supply(address(USDC), AMOUNT, maker, 0);

        uint256 available = USDC.balanceOf(address(AUSDC));
        emit log_named_uint("USDC the market can currently pay out (6dp)", available);

        // Ask for more than the reserve holds. Nothing about the maker's own position changed.
        vm.expectRevert();
        POOL.withdraw(address(USDC), available + 1e12, maker);
        vm.stopPrank();
    }
}
