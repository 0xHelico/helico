// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {HelicoVault} from "../src/HelicoVault.sol";
import {Mandate, MandateLib, PoolKey} from "../src/Mandate.sol";
import {MockERC20, MockStateView, RealisticPositionManager} from "./RealisticPositionManager.sol";
import {VaultV2} from "./VaultV2.sol";

contract HelicoVaultTest is Test {
    using MandateLib for PoolKey;
    using MandateLib for Mandate;

    HelicoVault vault;
    RealisticPositionManager pm;
    MockStateView stateView;
    MockERC20 t0;
    MockERC20 t1;

    address admin = makeAddr("admin");
    address agent = makeAddr("agent");
    address guardian = makeAddr("guardian");
    address upgrader = makeAddr("upgrader");
    address user = makeAddr("user");
    address stranger = makeAddr("stranger");

    int24 constant SPACING = 10;
    uint16 constant WIDTH = 100;
    uint128 constant LIQUIDITY = 1_000_000;
    uint16 constant RETENTION = 9_000;

    PoolKey poolKey;
    Mandate mandate;
    uint256 tokenId;

    function setUp() public {
        t0 = new MockERC20();
        t1 = new MockERC20();
        pm = new RealisticPositionManager(t0, t1);
        stateView = new MockStateView();

        HelicoVault impl = new HelicoVault();
        bytes memory data = abi.encodeCall(HelicoVault.initialize, (admin, address(pm), address(stateView)));
        vault = HelicoVault(address(new ERC1967Proxy(address(impl), data)));

        vm.startPrank(admin);
        vault.grantRole(vault.AGENT_ROLE(), agent);
        vault.grantRole(vault.GUARDIAN_ROLE(), guardian);
        vault.grantRole(vault.UPGRADER_ROLE(), upgrader);
        vm.stopPrank();

        poolKey = PoolKey({
            currency0: address(t0), currency1: address(t1), fee: 3000, tickSpacing: SPACING, hooks: address(0)
        });
        stateView.setTick(poolKey.hashPoolKey(), 0);

        // The position sits at [-300, -200] while the market is at tick 0, so re-centring it
        // onto [-50, 50] is a real improvement: the gap to the middle goes 250 -> 0.
        tokenId = pm.mintTo(user, poolKey, -300, -200, LIQUIDITY);
        vm.prank(user);
        pm.setApprovalForAll(address(vault), true);

        mandate = Mandate({
            poolId: poolKey.hashPoolKey(),
            rangeWidthTicks: WIDTH,
            minImprovementBps: 500,
            cooldownSeconds: 1 hours,
            maxLiquidity: LIQUIDITY,
            expiry: uint64(block.timestamp + 30 days),
            minRetainedBps: RETENTION
        });

        vm.prank(user);
        vault.setMandate(tokenId, mandate);
    }

    function _params(int24 lower, int24 upper) internal view returns (HelicoVault.RecenterParams memory) {
        return HelicoVault.RecenterParams({
            owner: user,
            tickLower: lower,
            tickUpper: upper,
            liquidityToMint: LIQUIDITY,
            amount0Min: 0,
            amount1Min: 0,
            amount0Max: type(uint128).max,
            amount1Max: type(uint128).max,
            deadline: block.timestamp + 60
        });
    }

    function _recenter(int24 lower, int24 upper) internal returns (uint256) {
        vm.prank(agent);
        return vault.recenter(_params(lower, upper));
    }

    // --- the happy path -----------------------------------------------------------------

    function test_AgentCanRecentreWithinMandate() public {
        uint256 newTokenId = _recenter(-50, 50);

        assertEq(pm.ownerOf(newTokenId), user, "the new position belongs to the user");
        assertEq(pm.getPositionLiquidity(newTokenId), LIQUIDITY, "liquidity moved across intact");
        assertEq(vault.lastActionAt(user), uint64(block.timestamp));
    }

    /// @notice v4 has no re-range action: re-centring burns the position and mints a new one
    ///         with a new id. A mandate keyed to the old id would be left pointing at a token
    ///         that no longer exists, and the cooldown with it.
    function test_MandateFollowsTheNewTokenId() public {
        uint256 newTokenId = _recenter(-50, 50);

        assertTrue(newTokenId != tokenId, "the id changes, as v4 requires");
        assertEq(vault.positionOf(user), newTokenId, "the mandate follows the position");
        assertTrue(vault.isActive(user), "and stays active");

        vm.expectRevert();
        pm.ownerOf(tokenId);
    }

    /// @notice Nothing may be left sitting in the vault. It is not a custodian.
    function test_VaultHoldsNothingAfterAnAction() public {
        pm.setFees(tokenId, 500, 700);
        _recenter(-50, 50);

        assertEq(t0.balanceOf(address(vault)), 0, "vault holds no token0");
        assertEq(t1.balanceOf(address(vault)), 0, "vault holds no token1");
        assertEq(t0.balanceOf(user), 500, "fees reached the user");
        assertEq(t1.balanceOf(user), 700, "fees reached the user");
    }

    // --- every rejection path -----------------------------------------------------------

    function test_RejectsCallerWithoutAgentRole() public {
        bytes32 role = vault.AGENT_ROLE();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role)
        );
        vault.recenter(_params(-50, 50));
    }

    function test_RejectsWrongRangeWidth() public {
        vm.prank(agent);
        vm.expectRevert(HelicoVault.RangeWidthMismatch.selector);
        vault.recenter(_params(-100, 100));
    }

    function test_RejectsUnspacedTicks() public {
        vm.prank(agent);
        vm.expectRevert(HelicoVault.TicksNotSpaced.selector);
        vault.recenter(_params(-45, 55));
    }

    function test_RejectsUnorderedTicks() public {
        vm.prank(agent);
        vm.expectRevert(HelicoVault.TicksNotOrdered.selector);
        vault.recenter(_params(50, -50));
    }

    function test_RejectsRangeThatDoesNotContainTheMarket() public {
        vm.prank(agent);
        vm.expectRevert(HelicoVault.RangeOffMarket.selector);
        vault.recenter(_params(1000, 1100));
    }

    /// @notice A range must be closer to the market than the one it replaces, by the margin
    ///         the user committed to. Closer by a hair is not what a 5% mandate asked for.
    /// @dev Market at tick 4. The position's middle sits at 50, so it is 46 ticks off. The
    ///      proposed middle at -40 is 44 ticks off - an improvement of 4.3%, under the 5%
    ///      committed. Both ranges are the committed width and both contain the market, so
    ///      this is the check that has to catch it.
    function test_RejectsMovementBelowTheCommittedImprovement() public {
        uint256 offset = pm.mintTo(user, poolKey, 0, 100, LIQUIDITY);
        vm.prank(user);
        vault.setMandate(offset, mandate);
        stateView.setTick(poolKey.hashPoolKey(), 4);

        vm.prank(agent);
        vm.expectRevert(HelicoVault.NotEnoughImprovement.selector);
        vault.recenter(_params(-90, 10));
    }

    function test_AcceptsMovementAtTheCommittedImprovement() public {
        uint256 offset = pm.mintTo(user, poolKey, 0, 100, LIQUIDITY);
        vm.prank(user);
        vault.setMandate(offset, mandate);
        stateView.setTick(poolKey.hashPoolKey(), 4);

        // Middle at 10, so 6 ticks off against 46 - comfortably past the 5% asked for.
        vm.prank(agent);
        uint256 moved = vault.recenter(_params(-40, 60));
        assertEq(pm.ownerOf(moved), user);
    }

    function test_RejectsLiquidityOverCap() public {
        Mandate memory tight = mandate;
        tight.maxLiquidity = LIQUIDITY - 1;
        vm.prank(user);
        vault.setMandate(tokenId, tight);

        vm.prank(agent);
        vm.expectRevert(HelicoVault.LiquidityTooLarge.selector);
        vault.recenter(_params(-50, 50));
    }

    function test_RejectsBeforeCooldownElapsed() public {
        _recenter(-50, 50);

        // Move the market so a second action would otherwise be a genuine improvement.
        stateView.setTick(poolKey.hashPoolKey(), 500);

        vm.prank(agent);
        vm.expectRevert(HelicoVault.CooldownNotElapsed.selector);
        vault.recenter(_params(450, 550));
    }

    function test_AllowsActionOnceCooldownElapsed() public {
        _recenter(-50, 50);
        stateView.setTick(poolKey.hashPoolKey(), 500);
        skip(1 hours);

        vm.prank(agent);
        uint256 third = vault.recenter(_params(450, 550));
        assertEq(pm.ownerOf(third), user);
    }

    function test_RejectsExpiredMandate() public {
        skip(31 days);
        vm.prank(agent);
        vm.expectRevert(HelicoVault.MandateExpired.selector);
        vault.recenter(_params(-50, 50));
    }

    function test_RejectsAfterRevoke() public {
        vm.prank(user);
        vault.revoke();

        vm.prank(agent);
        vm.expectRevert(HelicoVault.MandateInactive.selector);
        vault.recenter(_params(-50, 50));
    }

    function test_RejectsWhenPaused() public {
        vm.prank(guardian);
        vault.pause();

        vm.prank(agent);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.recenter(_params(-50, 50));
    }

    // --- the exit is always open --------------------------------------------------------

    function test_UserCanRevokeWhilePaused() public {
        vm.prank(guardian);
        vault.pause();

        vm.prank(user);
        vault.revoke();
        assertFalse(vault.isActive(user));
    }

    function test_UserCanRevokeWithAgentRemoved() public {
        bytes32 role = vault.AGENT_ROLE();
        vm.prank(admin);
        vault.revokeRole(role, agent);

        vm.prank(user);
        vault.revoke();
        assertFalse(vault.isActive(user));
    }

    function test_UserCanRevokeWithAnUpgradePending() public {
        VaultV2 v2 = new VaultV2();
        vm.prank(upgrader);
        vault.scheduleUpgrade(address(v2));

        vm.prank(user);
        vault.revoke();
        assertFalse(vault.isActive(user));
    }

    // --- committing a mandate -----------------------------------------------------------

    function test_OnlyOwnerCanSetAMandate() public {
        vm.prank(stranger);
        vm.expectRevert(HelicoVault.NotPositionOwner.selector);
        vault.setMandate(tokenId, mandate);
    }

    function test_RevokeWithoutAMandateReverts() public {
        vm.prank(stranger);
        vm.expectRevert(HelicoVault.MandateInactive.selector);
        vault.revoke();
    }

    function test_RejectsMandateForAnotherPool() public {
        Mandate memory wrong = mandate;
        wrong.poolId = keccak256("some other pool");
        vm.prank(user);
        vm.expectRevert(HelicoVault.PoolNotPermitted.selector);
        vault.setMandate(tokenId, wrong);
    }

    /// @notice A width that is not a whole number of tick spacings is refused outright, rather
    ///         than snapped to something the user did not choose.
    function test_RejectsWidthThatIsNotAWholeNumberOfSpacings() public {
        Mandate memory odd = mandate;
        odd.rangeWidthTicks = 105;
        vm.prank(user);
        vm.expectRevert(HelicoVault.RangeWidthNotSpaced.selector);
        vault.setMandate(tokenId, odd);
    }

    function test_RejectsMandateAlreadyExpired() public {
        Mandate memory stale = mandate;
        stale.expiry = uint64(block.timestamp);
        vm.prank(user);
        vm.expectRevert(HelicoVault.MandateExpired.selector);
        vault.setMandate(tokenId, stale);
    }

    function test_RejectsImprovementOfAHundredPercentOrMore() public {
        Mandate memory impossible = mandate;
        impossible.minImprovementBps = 10_000;
        vm.prank(user);
        vm.expectRevert(HelicoVault.ImprovementOutOfRange.selector);
        vault.setMandate(tokenId, impossible);
    }

    function test_RejectsZeroCaps() public {
        Mandate memory zeroWidth = mandate;
        zeroWidth.rangeWidthTicks = 0;
        vm.prank(user);
        vm.expectRevert(HelicoVault.RangeWidthZero.selector);
        vault.setMandate(tokenId, zeroWidth);

        Mandate memory zeroCap = mandate;
        zeroCap.maxLiquidity = 0;
        vm.prank(user);
        vm.expectRevert(HelicoVault.MaxLiquidityZero.selector);
        vault.setMandate(tokenId, zeroCap);
    }

    // --- upgrades -----------------------------------------------------------------------

    function test_UpgradeRequiresSchedulingAndDelay() public {
        VaultV2 v2 = new VaultV2();

        vm.prank(upgrader);
        vm.expectRevert(HelicoVault.UpgradeNotScheduled.selector);
        vault.upgradeToAndCall(address(v2), "");

        vm.prank(upgrader);
        vault.scheduleUpgrade(address(v2));

        vm.prank(upgrader);
        vm.expectRevert(HelicoVault.UpgradeNotReady.selector);
        vault.upgradeToAndCall(address(v2), "");

        skip(2 days);
        vm.prank(upgrader);
        vault.upgradeToAndCall(address(v2), "");

        assertEq(VaultV2(address(vault)).version(), 2);
    }

    function test_UpgradeRejectsCallerWithoutRole() public {
        VaultV2 v2 = new VaultV2();
        vm.prank(upgrader);
        vault.scheduleUpgrade(address(v2));
        skip(2 days);

        bytes32 role = vault.UPGRADER_ROLE();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role)
        );
        vault.upgradeToAndCall(address(v2), "");
    }

    function test_UpgradeCanBeCancelled() public {
        VaultV2 v2 = new VaultV2();
        vm.startPrank(upgrader);
        vault.scheduleUpgrade(address(v2));
        vault.cancelUpgrade(address(v2));
        skip(2 days);
        vm.expectRevert(HelicoVault.UpgradeNotScheduled.selector);
        vault.upgradeToAndCall(address(v2), "");
        vm.stopPrank();
    }

    function test_AgentCannotUpgrade() public {
        VaultV2 v2 = new VaultV2();
        bytes32 role = vault.UPGRADER_ROLE();
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, agent, role)
        );
        vault.scheduleUpgrade(address(v2));
    }

    // --- how much liquidity has to survive ----------------------------------------------

    /// @notice How much to mint is the agent's number, and every other check is about where
    ///         value went. An agent that mints dust passes all of them while ending the
    ///         position, so the floor is measured from what was actually delivered.
    function test_RejectsARecentreThatKeepsTooLittleLiquidity() public {
        HelicoVault.RecenterParams memory p = _params(-50, 50);
        p.liquidityToMint = 899_999; // one short of 90% of 1,000,000

        vm.prank(agent);
        vm.expectRevert(HelicoVault.LiquidityNotRetained.selector);
        vault.recenter(p);
    }

    function test_AcceptsARecentreExactlyAtTheRetentionFloor() public {
        HelicoVault.RecenterParams memory p = _params(-50, 50);
        p.liquidityToMint = 900_000;

        vm.prank(agent);
        uint256 moved = vault.recenter(p);

        assertEq(pm.getPositionLiquidity(moved), 900_000, "the floor is inclusive");
        assertEq(t0.balanceOf(user), 100_000, "what did not fit went to the owner");
    }

    /// @notice Zero is a choice, not a default: it permits a dust mint, explicitly.
    function test_RetentionOfZeroPermitsADustMint() public {
        Mandate memory loose = mandate;
        loose.minRetainedBps = 0;
        vm.prank(user);
        vault.setMandate(tokenId, loose);

        HelicoVault.RecenterParams memory p = _params(-50, 50);
        p.liquidityToMint = 1;

        vm.prank(agent);
        uint256 dust = vault.recenter(p);
        assertEq(pm.getPositionLiquidity(dust), 1);
    }

    /// @notice But it does not permit minting *nothing*, which is a withdrawal with a
    ///         re-centre's name on it.
    /// @dev The floor cannot catch this on its own: `0 * BPS < liquidityBefore * 0` is false,
    ///      so a mandate that opted out of the floor would let the whole position be burned and
    ///      paid out. Refused above the floor and independent of it. The workflow reached the
    ///      same conclusion from the other side and holds rather than emitting such a verdict.
    function test_RejectsAMintOfNothingEvenWithNoRetentionFloor() public {
        Mandate memory loose = mandate;
        loose.minRetainedBps = 0;
        vm.prank(user);
        vault.setMandate(tokenId, loose);

        HelicoVault.RecenterParams memory p = _params(-50, 50);
        p.liquidityToMint = 0;

        vm.prank(agent);
        vm.expectRevert(HelicoVault.NothingToMint.selector);
        vault.recenter(p);
    }

    function test_RejectsAMintOfNothingWithAFloorToo() public {
        HelicoVault.RecenterParams memory p = _params(-50, 50);
        p.liquidityToMint = 0;

        vm.prank(agent);
        vm.expectRevert(HelicoVault.NothingToMint.selector);
        vault.recenter(p);
    }

    function test_RejectsRetentionAboveOneHundredPercent() public {
        Mandate memory impossible = mandate;
        impossible.minRetainedBps = 10_001;
        vm.prank(user);
        vm.expectRevert(HelicoVault.RetentionOutOfRange.selector);
        vault.setMandate(tokenId, impossible);
    }

    // --- the agreement with the enclave -------------------------------------------------

    /// @notice The workflow inside the enclave recomputes the mandate hash from a flat tuple
    ///         of the same six types. If a field here is reordered or resized, that hash stops
    ///         matching and every action is rejected on-chain for no visible reason.
    /// @dev Deliberately spelled out rather than derived, so the encoding cannot drift on this
    ///      side without the test being edited too. The mirror of this lives in
    ///      `packages/plugins/cre/src/mandate.test.ts`.
    function test_MandateHashMatchesTheTupleTheEnclaveEncodes() public view {
        bytes32 fromStruct = MandateLib.hash(mandate);
        bytes32 fromTuple = keccak256(
            abi.encode(
                mandate.poolId,
                mandate.rangeWidthTicks,
                mandate.minImprovementBps,
                mandate.cooldownSeconds,
                mandate.maxLiquidity,
                mandate.expiry,
                mandate.minRetainedBps
            )
        );
        assertEq(fromStruct, fromTuple, "bytes32,uint16,uint16,uint32,uint128,uint64,uint16");
    }

    /// @notice The same vector as `packages/plugins/cre/src/mandate.test.ts`, generated by a
    ///         third tool so neither side is checking its own work:
    ///
    ///         cast abi-encode "f((bytes32,uint16,uint16,uint32,uint128,uint64,uint16))" \\
    ///           "(0xea84...c5,1000,50,3600,1000000000000000000,1800000000,9000)" | cast keccak
    ///
    /// @dev If this literal and the one in the TypeScript test ever disagree, the enclave is
    ///      computing a hash the vault will reject, and every action fails on-chain for no
    ///      visible reason. One literal, two languages, checked in both.
    function test_MandateHashMatchesTheVectorTheEnclaveIsPinnedTo() public pure {
        Mandate memory vector = Mandate({
            poolId: 0xea84630b1ccfd69145b791334c55a7d8be1565910cb6e290c489413c977fd9c5,
            rangeWidthTicks: 1000,
            minImprovementBps: 50,
            cooldownSeconds: 3600,
            maxLiquidity: 1e18,
            expiry: 1_800_000_000,
            minRetainedBps: 9000
        });

        assertEq(
            MandateLib.hash(vector),
            0x134be6bb4e1c442551c22dfe96cb5b7c3c31babb386e2e9a051e57ee329a6225,
            "the enclave and the vault must hash the same bytes"
        );
    }

    // --- deployment ---------------------------------------------------------------------

    function test_ImplementationCannotBeInitialised() public {
        HelicoVault impl = new HelicoVault();
        vm.expectRevert();
        impl.initialize(admin, address(pm), address(stateView));
    }

    function test_RejectsZeroAddressesOnInitialize() public {
        HelicoVault impl = new HelicoVault();

        vm.expectRevert(HelicoVault.ZeroAddress.selector);
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(HelicoVault.initialize, (address(0), address(pm), address(stateView)))
        );

        vm.expectRevert(HelicoVault.ZeroAddress.selector);
        new ERC1967Proxy(
            address(impl), abi.encodeCall(HelicoVault.initialize, (admin, address(0), address(stateView)))
        );

        vm.expectRevert(HelicoVault.ZeroAddress.selector);
        new ERC1967Proxy(
            address(impl), abi.encodeCall(HelicoVault.initialize, (admin, address(pm), address(0)))
        );
    }
}
