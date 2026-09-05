// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {HelicoVault} from "../src/HelicoVault.sol";
import {Mandate, MandateLib, PoolKey} from "../src/Mandate.sol";
import {MockERC20, MockStateView, RealisticPositionManager} from "./RealisticPositionManager.sol";
import {VaultV2} from "./VaultV2.sol";

/// @notice The security properties Helico claims, written as tests.
///
/// @dev These came out of a twelve-agent audit of the first vault draft. Each one states
///      something the README already promises a user - that an agent cannot touch a position
///      they never committed, that revoking ends it, that proceeds can only reach the owner -
///      and checks the contract actually delivers it.
///
///      They were written before the contract could pass them, against a PositionManager mock
///      that behaves like v4's rather than one that records arguments and refuses nothing. The
///      commit that added them is red on all nine; this file is what it looks like once the
///      contract earns them.
contract VaultAttacksTest is Test {
    using MandateLib for PoolKey;

    HelicoVault vault;
    RealisticPositionManager pm;
    MockStateView stateView;
    MockERC20 t0;
    MockERC20 t1;

    address admin = makeAddr("admin");
    address upgrader = makeAddr("upgrader");
    address agent = makeAddr("agent");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    PoolKey key;
    uint256 aliceToken;
    uint256 agentToken;

    uint128 constant ALICE_LIQUIDITY = 1_000_000;
    int24 constant SPACING = 10;
    uint16 constant WIDTH = 100;

    function setUp() public {
        t0 = new MockERC20();
        t1 = new MockERC20();
        pm = new RealisticPositionManager(t0, t1);
        stateView = new MockStateView();

        HelicoVault impl = new HelicoVault();
        vault = HelicoVault(
            address(
                new ERC1967Proxy(
                    address(impl),
                    abi.encodeCall(HelicoVault.initialize, (admin, address(pm), address(stateView)))
                )
            )
        );

        bytes32 agentRole = vault.AGENT_ROLE();
        bytes32 upgraderRole = vault.UPGRADER_ROLE();
        vm.startPrank(admin);
        vault.grantRole(agentRole, agent);
        vault.grantRole(upgraderRole, upgrader);
        vm.stopPrank();

        key = PoolKey({
            currency0: address(t0), currency1: address(t1), fee: 3000, tickSpacing: SPACING, hooks: address(0)
        });
        stateView.setTick(key.hashPoolKey(), 0);

        // Alice holds a real position and approves the vault, exactly as the README instructs.
        aliceToken = pm.mintTo(alice, key, -300, -200, ALICE_LIQUIDITY);
        vm.prank(alice);
        pm.setApprovalForAll(address(vault), true);

        // The agent holds a worthless throwaway position they legitimately own, and a mandate
        // on it that is beyond reproach. This is the lever the original drain used.
        agentToken = pm.mintTo(agent, key, -300, -200, 1);
        vm.prank(agent);
        vault.setMandate(agentToken, _mandate(type(uint128).max));
    }

    function _mandate(uint128 cap) internal view returns (Mandate memory) {
        return Mandate({
            poolId: key.hashPoolKey(),
            rangeWidthTicks: WIDTH,
            minImprovementBps: 500,
            cooldownSeconds: 1 hours,
            maxLiquidity: cap,
            expiry: uint64(block.timestamp + 30 days)
        });
    }

    function _params(address owner, int24 lower, int24 upper)
        internal
        view
        returns (HelicoVault.RecenterParams memory)
    {
        return HelicoVault.RecenterParams({
            owner: owner,
            tickLower: lower,
            tickUpper: upper,
            liquidityToMint: 1,
            amount0Min: 0,
            amount1Min: 0,
            amount0Max: type(uint128).max,
            amount1Max: type(uint128).max,
            deadline: block.timestamp + 60
        });
    }

    // --- who the agent may act on --------------------------------------------------------

    /// @notice A user who never opted in is untouchable, even by an agent holding a perfectly
    ///         valid mandate on a position of their own.
    /// @dev The original vector was a payload naming Alice's tokenId while the mandate checks
    ///      ran against the agent's. It is not merely rejected now, it is unrepresentable:
    ///      `recenter` takes no payload, and the only tokenId it can act on is the one the
    ///      named owner's own mandate points at.
    function test_AgentCannotActOnAPositionWithoutAMandate() public {
        vm.prank(agent);
        vm.expectRevert(HelicoVault.MandateInactive.selector);
        vault.recenter(_params(alice, -50, 50));

        assertEq(pm.getPositionLiquidity(aliceToken), ALICE_LIQUIDITY, "alice never opted in");
        assertEq(t0.balanceOf(agent), 0, "agent must not hold alice's token0");
        assertEq(t1.balanceOf(agent), 0, "agent must not hold alice's token1");
    }

    /// @notice Value leaving a position may only reach the position's owner.
    /// @dev There is no recipient parameter. Both addresses in the payload are the owner the
    ///      contract read from `ownerOf`, so this asserts where the money lands on the one
    ///      path that exists.
    function test_ProceedsCanOnlyReachTheOwner() public {
        vm.prank(alice);
        vault.setMandate(aliceToken, _mandate(type(uint128).max));
        pm.setFees(aliceToken, 4_000, 9_000);

        HelicoVault.RecenterParams memory p = _params(alice, -50, 50);
        p.liquidityToMint = ALICE_LIQUIDITY;
        vm.prank(agent);
        uint256 newTokenId = vault.recenter(p);

        assertEq(t0.balanceOf(agent), 0, "agent must not be a payout destination");
        assertEq(t1.balanceOf(agent), 0, "agent must not be a payout destination");
        assertEq(t0.balanceOf(address(vault)), 0, "the vault is not a custodian");
        assertEq(t1.balanceOf(address(vault)), 0, "the vault is not a custodian");
        assertEq(t0.balanceOf(alice), 4_000, "fees reached the owner");
        assertEq(t1.balanceOf(alice), 9_000, "fees reached the owner");
        assertEq(pm.ownerOf(newTokenId), alice, "and so did the new position");
    }

    /// @notice Revoking ends the agent's authority. This is the exit the README promises.
    function test_RevokeStopsTheAgent() public {
        vm.startPrank(alice);
        vault.setMandate(aliceToken, _mandate(type(uint128).max));
        vault.revoke();
        vm.stopPrank();

        vm.prank(agent);
        vm.expectRevert(HelicoVault.MandateInactive.selector);
        vault.recenter(_params(alice, -50, 50));

        assertEq(pm.getPositionLiquidity(aliceToken), ALICE_LIQUIDITY, "revoke must stop the agent");
    }

    /// @notice A mandate is a promise between a user and the agent. Selling the position must
    ///         not hand the buyer's liquidity to an agent they never chose.
    function test_MandateDoesNotSurviveOwnershipTransfer() public {
        vm.startPrank(alice);
        vault.setMandate(aliceToken, _mandate(type(uint128).max));
        pm.transferFrom(alice, bob, aliceToken);
        vm.stopPrank();

        vm.prank(agent);
        vm.expectRevert(HelicoVault.NotPositionOwner.selector);
        vault.recenter(_params(alice, -50, 50));
    }

    /// @notice v4 reserves address(1) and address(2) as "the caller" and "the PositionManager".
    ///         Encoding either as the owner would send a payout somewhere other than a person.
    function test_AgentCannotUseAReservedAddressAsOwner() public {
        address reserved = address(2);
        uint256 reservedToken = pm.mintTo(reserved, key, -300, -200, ALICE_LIQUIDITY);
        vm.startPrank(reserved);
        pm.setApprovalForAll(address(vault), true);
        vault.setMandate(reservedToken, _mandate(type(uint128).max));
        vm.stopPrank();

        vm.prank(agent);
        vm.expectRevert(HelicoVault.UnusableOwner.selector);
        vault.recenter(_params(reserved, -50, 50));
    }

    // --- what the agent may do -----------------------------------------------------------

    /// @notice A range that does not contain the market price earns nothing. Every griefing
    ///         payload takes this shape, and width alone does not catch it.
    function test_RangeMustBracketTheMarketPrice() public {
        vm.prank(alice);
        vault.setMandate(aliceToken, _mandate(type(uint128).max));

        // Ordered, both aligned to spacing 10, exactly 100 ticks wide - and roughly 22,000x
        // away from a market sitting at tick 0.
        vm.prank(agent);
        vm.expectRevert(HelicoVault.RangeOffMarket.selector);
        vault.recenter(_params(alice, 100_000, 100_100));
    }

    /// @notice The size cap is measured from the position, not read off a number the agent
    ///         typed into the call. There is no longer a number to type.
    function test_SizeCapIsMeasuredNotDeclared() public {
        vm.prank(alice);
        vault.setMandate(aliceToken, _mandate(1_000));

        vm.prank(agent);
        vm.expectRevert(HelicoVault.LiquidityTooLarge.selector);
        vault.recenter(_params(alice, -50, 50));
    }

    /// @notice `minImprovementBps` is committed and hashed into the user's mandate. It has to
    ///         mean something: an action that moves the range no closer to the market is churn.
    function test_ActionMustImproveOnWhereTheLiquidityAlreadySits() public {
        uint256 centred = pm.mintTo(alice, key, -50, 50, ALICE_LIQUIDITY);
        vm.prank(alice);
        vault.setMandate(centred, _mandate(type(uint128).max));

        vm.prank(agent);
        vm.expectRevert(HelicoVault.NotEnoughImprovement.selector);
        vault.recenter(_params(alice, -50, 50));
    }

    /// @notice Re-centring in v4 destroys the tokenId it acted on. A cooldown clocked against
    ///         the old id would never bind again, so the agent could churn every block.
    function test_CooldownBindsAcrossTheTokenIdChange() public {
        vm.prank(alice);
        vault.setMandate(aliceToken, _mandate(type(uint128).max));

        HelicoVault.RecenterParams memory p = _params(alice, -50, 50);
        p.liquidityToMint = ALICE_LIQUIDITY;
        vm.prank(agent);
        uint256 second = vault.recenter(p);

        assertTrue(second != aliceToken, "the position has a new id");
        assertEq(vault.positionOf(alice), second, "the mandate followed it");

        stateView.setTick(key.hashPoolKey(), 500);
        HelicoVault.RecenterParams memory again = _params(alice, 450, 550);
        again.liquidityToMint = ALICE_LIQUIDITY;
        vm.prank(agent);
        vm.expectRevert(HelicoVault.CooldownNotElapsed.selector);
        vault.recenter(again);
    }

    // --- upgrades ------------------------------------------------------------------------

    /// @notice A schedule that never expires is a permanent standing authorisation, not a
    ///         two-day notice period.
    function test_ScheduledUpgradeExpires() public {
        VaultV2 v2 = new VaultV2();

        vm.prank(upgrader);
        vault.scheduleUpgrade(address(v2));

        skip(3650 days);

        vm.prank(upgrader);
        vm.expectRevert(HelicoVault.UpgradeExpired.selector);
        vault.upgradeToAndCall(address(v2), "");
    }

    /// @notice Scheduling an address with no code announces nothing a user could inspect.
    function test_UpgradeCannotBeScheduledForAnAddressWithNoCode() public {
        vm.prank(upgrader);
        vm.expectRevert(HelicoVault.NotAContract.selector);
        vault.scheduleUpgrade(makeAddr("not a contract"));
    }
}
