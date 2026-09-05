// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {HelicoVault} from "../src/HelicoVault.sol";
import {Mandate, MandateLib, PoolKey} from "../src/Mandate.sol";
import {MockPositionManager} from "./MockPositionManager.sol";
import {VaultV2} from "./VaultV2.sol";

contract HelicoVaultTest is Test {
    using MandateLib for PoolKey;

    HelicoVault vault;
    MockPositionManager pm;

    address admin = makeAddr("admin");
    address agent = makeAddr("agent");
    address guardian = makeAddr("guardian");
    address upgrader = makeAddr("upgrader");
    address user = makeAddr("user");
    address stranger = makeAddr("stranger");

    uint256 constant TOKEN_ID = 1;
    int24 constant SPACING = 10;

    PoolKey poolKey;
    Mandate mandate;

    function setUp() public {
        pm = new MockPositionManager();
        pm.setOwner(TOKEN_ID, user);

        HelicoVault impl = new HelicoVault();
        bytes memory data = abi.encodeCall(HelicoVault.initialize, (admin, address(pm)));
        vault = HelicoVault(address(new ERC1967Proxy(address(impl), data)));

        vm.startPrank(admin);
        vault.grantRole(vault.AGENT_ROLE(), agent);
        vault.grantRole(vault.GUARDIAN_ROLE(), guardian);
        vault.grantRole(vault.UPGRADER_ROLE(), upgrader);
        vm.stopPrank();

        poolKey = PoolKey({
            currency0: address(0xA),
            currency1: address(0xB),
            fee: 3000,
            tickSpacing: SPACING,
            hooks: address(0)
        });

        mandate = Mandate({
            poolId: poolKey.hashPoolKey(),
            rangeWidthBps: 100,
            minImprovementBps: 50,
            cooldownSeconds: 1 hours,
            maxNotional: 10 ether,
            expiry: uint64(block.timestamp + 30 days)
        });

        vm.prank(user);
        vault.setMandate(TOKEN_ID, mandate);
    }

    // rangeWidthBps 100 snapped to spacing 10 is 100 ticks wide.
    function _validTicks() internal pure returns (int24, int24) {
        return (-50, 50);
    }

    function _recenter(int24 lower, int24 upper) internal {
        vm.prank(agent);
        vault.recenter(TOKEN_ID, poolKey, lower, upper, 1 ether, hex"1234", block.timestamp + 60);
    }

    // --- the happy path -----------------------------------------------------------------

    function test_AgentCanRecentreWithinMandate() public {
        (int24 lower, int24 upper) = _validTicks();
        _recenter(lower, upper);

        assertEq(pm.callCount(), 1, "vault should forward to the position manager");
        assertEq(pm.lastUnlockData(), hex"1234");
        assertEq(vault.lastActionAt(TOKEN_ID), uint64(block.timestamp));
    }

    // --- every rejection path -----------------------------------------------------------

    function test_RejectsCallerWithoutAgentRole() public {
        (int24 lower, int24 upper) = _validTicks();
        bytes32 role = vault.AGENT_ROLE();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role)
        );
        vault.recenter(TOKEN_ID, poolKey, lower, upper, 1 ether, hex"", block.timestamp + 60);
    }

    function test_RejectsWrongPool() public {
        PoolKey memory other = poolKey;
        other.fee = 500;
        (int24 lower, int24 upper) = _validTicks();

        vm.prank(agent);
        vm.expectRevert(HelicoVault.PoolNotPermitted.selector);
        vault.recenter(TOKEN_ID, other, lower, upper, 1 ether, hex"", block.timestamp + 60);
    }

    function test_RejectsWrongRangeWidth() public {
        vm.expectRevert(HelicoVault.RangeWidthMismatch.selector);
        _recenter(-100, 100);
    }

    function test_RejectsUnspacedTicks() public {
        vm.expectRevert(HelicoVault.TicksNotSpaced.selector);
        _recenter(-55, 45);
    }

    function test_RejectsUnorderedTicks() public {
        vm.expectRevert(HelicoVault.TicksNotOrdered.selector);
        _recenter(50, -50);
    }

    function test_RejectsNotionalOverCap() public {
        (int24 lower, int24 upper) = _validTicks();
        vm.prank(agent);
        vm.expectRevert(HelicoVault.NotionalTooLarge.selector);
        vault.recenter(TOKEN_ID, poolKey, lower, upper, 11 ether, hex"", block.timestamp + 60);
    }

    function test_RejectsBeforeCooldownElapsed() public {
        (int24 lower, int24 upper) = _validTicks();
        _recenter(lower, upper);

        vm.warp(block.timestamp + 59 minutes);
        vm.expectRevert(HelicoVault.CooldownNotElapsed.selector);
        _recenter(lower, upper);

        vm.warp(block.timestamp + 2 minutes);
        _recenter(lower, upper);
        assertEq(pm.callCount(), 2, "should act once the cooldown has passed");
    }

    function test_RejectsExpiredMandate() public {
        vm.warp(block.timestamp + 31 days);
        (int24 lower, int24 upper) = _validTicks();
        vm.expectRevert(HelicoVault.MandateExpired.selector);
        _recenter(lower, upper);
    }

    function test_RejectsAfterRevoke() public {
        vm.prank(user);
        vault.revoke(TOKEN_ID);

        (int24 lower, int24 upper) = _validTicks();
        vm.expectRevert(HelicoVault.MandateInactive.selector);
        _recenter(lower, upper);
    }

    function test_RejectsWhenPaused() public {
        vm.prank(guardian);
        vault.pause();

        (int24 lower, int24 upper) = _validTicks();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        _recenter(lower, upper);
    }

    // --- the exit must always work -------------------------------------------------------

    function test_UserCanRevokeWhilePaused() public {
        vm.prank(guardian);
        vault.pause();

        vm.prank(user);
        vault.revoke(TOKEN_ID);

        assertFalse(vault.isActive(TOKEN_ID), "pause must never trap a user");
    }

    function test_UserCanRevokeWithAgentRemoved() public {
        bytes32 role = vault.AGENT_ROLE();
        vm.prank(admin);
        vault.revokeRole(role, agent);

        vm.prank(user);
        vault.revoke(TOKEN_ID);

        assertFalse(vault.isActive(TOKEN_ID));
    }

    function test_OnlyOwnerCanSetOrRevoke() public {
        vm.prank(stranger);
        vm.expectRevert(HelicoVault.NotPositionOwner.selector);
        vault.setMandate(TOKEN_ID, mandate);

        vm.prank(stranger);
        vm.expectRevert(HelicoVault.NotPositionOwner.selector);
        vault.revoke(TOKEN_ID);
    }

    // --- upgrades ------------------------------------------------------------------------

    function test_UpgradeRequiresSchedulingAndDelay() public {
        VaultV2 next = new VaultV2();

        vm.prank(upgrader);
        vm.expectRevert(HelicoVault.UpgradeNotScheduled.selector);
        vault.upgradeToAndCall(address(next), "");

        vm.prank(upgrader);
        vault.scheduleUpgrade(address(next));

        vm.prank(upgrader);
        vm.expectRevert(HelicoVault.UpgradeNotReady.selector);
        vault.upgradeToAndCall(address(next), "");

        vm.warp(block.timestamp + 2 days);
        vm.prank(upgrader);
        vault.upgradeToAndCall(address(next), "");

        assertEq(VaultV2(address(vault)).version(), 2, "upgrade should land after the delay");
    }

    function test_UpgradeRejectsCallerWithoutRole() public {
        VaultV2 next = new VaultV2();

        bytes32 role = vault.UPGRADER_ROLE();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role)
        );
        vault.scheduleUpgrade(address(next));
    }

    function test_UpgradeCanBeCancelled() public {
        VaultV2 next = new VaultV2();

        vm.startPrank(upgrader);
        vault.scheduleUpgrade(address(next));
        vault.cancelUpgrade(address(next));
        vm.warp(block.timestamp + 2 days);

        vm.expectRevert(HelicoVault.UpgradeNotScheduled.selector);
        vault.upgradeToAndCall(address(next), "");
        vm.stopPrank();
    }

    function test_AgentCannotUpgrade() public {
        VaultV2 next = new VaultV2();
        bytes32 role = vault.UPGRADER_ROLE();
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, agent, role)
        );
        vault.scheduleUpgrade(address(next));
    }

    // --- initialisation ------------------------------------------------------------------

    function test_ImplementationCannotBeInitialised() public {
        HelicoVault impl = new HelicoVault();
        vm.expectRevert();
        impl.initialize(admin, address(pm));
    }

    function test_RejectsZeroAddressesOnInitialize() public {
        HelicoVault impl = new HelicoVault();
        vm.expectRevert(HelicoVault.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), abi.encodeCall(HelicoVault.initialize, (address(0), address(pm))));
    }
}
