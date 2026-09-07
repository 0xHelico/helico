// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {stdError, Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Aqua} from "@1inch/aqua/Aqua.sol";
import {IAqua} from "@1inch/aqua/interfaces/IAqua.sol";

interface IAavePool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
    function getVirtualUnderlyingBalance(address asset) external view returns (uint128);
}

/// @notice Can the unwind budget live in Aqua's own ledger instead of an ERC-20 approval to us?
///
/// @dev This decides the whole design. The obvious way to unwind a maker's Aave position is to
///      take an aToken approval — and that hands us unlimited, mandate-independent power over
///      their entire lending position, surviving `dock` and expiry alike, with no protection
///      from Aave because its health-factor checks only run for borrowers.
///
///      The alternative: an aToken is an ordinary ERC-20, and Aqua's ledger is a per-mandate,
///      revocable allowance. So ship the aToken *as a token in the strategy* and pull it like
///      any other. The approval then goes to Aqua, which the maker already trusts, and the
///      budget is a number they chose and can burn with `dock`.
contract ForkAquaHoldsATokensTest is Test {
    IAavePool constant POOL = IAavePool(0x794a61358D6845594F94dc1DB02A252b5b4814aD);
    IERC20 constant USDC = IERC20(0xaf88d065e77c8cC2239327C5EDb3A432268e5831);
    IERC20 constant AUSDC = IERC20(0x724dc807b04555b71ed48a6896b6F41593b8C637);

    Aqua aqua;
    address maker = address(0xA11CE);
    address app = address(0xA99);
    uint256 constant SUPPLIED = 100_000e6;
    uint256 constant BUDGET = 60_000e6;

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
            return;
        }
        aqua = new Aqua();
    }

    function test_AnATokenCanBeShippedToAquaAndPulledLikeAnyOther() public {
        deal(address(USDC), maker, SUPPLIED);

        vm.startPrank(maker);
        USDC.approve(address(POOL), SUPPLIED);
        POOL.supply(address(USDC), SUPPLIED, maker, 0);

        // The only approval in the design, and it goes to Aqua rather than to us.
        AUSDC.approve(address(aqua), type(uint256).max);

        address[] memory tokens = new address[](1);
        tokens[0] = address(AUSDC);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = BUDGET;
        bytes32 hash = aqua.ship(app, abi.encode("mandate"), tokens, amounts);
        vm.stopPrank();

        (uint256 budget,) = aqua.rawBalances(maker, app, hash, address(AUSDC));
        assertEq(budget, BUDGET, "the unwind budget is a number the maker chose");

        // What the app does inside a swap: pull the receipt token to itself, then burn it.
        uint256 deficit = 40_000e6;
        vm.startPrank(app);
        aqua.pull(maker, hash, address(AUSDC), deficit, app);
        uint256 got = POOL.withdraw(address(USDC), type(uint256).max, maker);
        vm.stopPrank();

        assertGe(got, deficit, "the underlying reached the maker's wallet");
        assertEq(USDC.balanceOf(maker), got, "and it is theirs, not ours");
        assertEq(AUSDC.balanceOf(app), 0, "the app kept no receipt token");
        assertEq(USDC.balanceOf(app), 0, "and no underlying");

        (uint256 left,) = aqua.rawBalances(maker, app, hash, address(AUSDC));
        assertEq(left, BUDGET - deficit, "the budget fell by exactly what was unwound");
    }

    /// @dev The property the aToken approval could never have: the maker can end it, and ending
    ///      it ends our access completely.
    function test_DockingBurnsOurAbilityToTouchTheLendingPosition() public {
        deal(address(USDC), maker, SUPPLIED);

        vm.startPrank(maker);
        USDC.approve(address(POOL), SUPPLIED);
        POOL.supply(address(USDC), SUPPLIED, maker, 0);
        AUSDC.approve(address(aqua), type(uint256).max);

        address[] memory tokens = new address[](1);
        tokens[0] = address(AUSDC);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = BUDGET;
        bytes32 hash = aqua.ship(app, abi.encode("mandate"), tokens, amounts);

        aqua.dock(app, hash, tokens);
        vm.stopPrank();

        // The maker still holds the aToken approval to Aqua, and still has the position. But the
        // budget is gone, so nothing can be taken. Underflow, because `pull` has no active check.
        vm.prank(app);
        vm.expectRevert(stdError.arithmeticError);
        aqua.pull(maker, hash, address(AUSDC), 1e6, app);

        assertGe(AUSDC.balanceOf(maker), SUPPLIED - 10, "the position is untouched and still earning");
    }

    /// @dev The number a pre-check must read. `balanceOf(aToken)` is a different figure and the
    ///      two disagree by thousands of USDC.
    function test_TheLiquidityCeilingIsVirtualNotTheATokensBalance() public {
        uint256 virtualBal = POOL.getVirtualUnderlyingBalance(address(USDC));
        uint256 held = USDC.balanceOf(address(AUSDC));
        emit log_named_uint("virtualUnderlyingBalance (6dp)", virtualBal);
        emit log_named_uint("USDC.balanceOf(aToken)   (6dp)", held);
        assertTrue(virtualBal != held, "the two figures are not interchangeable");
    }
}
