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
/// @dev These came out of a twelve-agent audit of `HelicoVault`. Each one states something the
///      README already promises a user — that an agent cannot touch a position they never
///      committed, that revoking ends it, that proceeds can only reach the owner — and checks
///      the contract actually delivers it.
///
///      They are deliberately written before the contract can pass them. The suite that
///      shipped alongside the first draft was green against a vault any `AGENT_ROLE` holder
///      could drain, because its mock only recorded arguments and could never refuse anything.
///      A green suite is worth exactly as much as the mock behind it.
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
                new ERC1967Proxy(address(impl), abi.encodeCall(HelicoVault.initialize, (admin, address(pm))))
            )
        );

        bytes32 agentRole = vault.AGENT_ROLE();
        bytes32 upgraderRole = vault.UPGRADER_ROLE();
        vm.startPrank(admin);
        vault.grantRole(agentRole, agent);
        vault.grantRole(upgraderRole, upgrader);
        vm.stopPrank();

        key = PoolKey({
            currency0: address(t0),
            currency1: address(t1),
            fee: 3000,
            tickSpacing: SPACING,
            hooks: address(0)
        });
        stateView.setTick(key.hashPoolKey(), 0);

        // Alice holds a real position and approves the vault, exactly as the README instructs.
        aliceToken = pm.mintTo(alice, key, -300, -200, ALICE_LIQUIDITY);
        vm.prank(alice);
        pm.setApprovalForAll(address(vault), true);

        // The agent holds a worthless throwaway position they legitimately own.
        agentToken = pm.mintTo(agent, key, -50, 50, 1);
    }

    function _mandate(uint128 cap) internal view returns (Mandate memory) {
        return Mandate({
            poolId: key.hashPoolKey(),
            rangeWidthBps: WIDTH,
            minImprovementBps: 500,
            cooldownSeconds: 1 hours,
            maxNotional: cap,
            expiry: uint64(block.timestamp + 30 days)
        });
    }

    /// @dev The payload an agent would send to take somebody else's position:
    ///      DECREASE_LIQUIDITY on a token the vault is approved for, then TAKE_PAIR to itself.
    function _drainPayload(uint256 tokenId, address to) internal pure returns (bytes memory) {
        bytes memory actions = abi.encodePacked(uint8(0x01), uint8(0x11));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(tokenId, uint256(ALICE_LIQUIDITY), uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(address(0), address(0), to);
        return abi.encode(actions, params);
    }

    function _noop() internal pure returns (bytes memory) {
        return abi.encode(bytes(""), new bytes[](0));
    }

    // --- who the agent may act on --------------------------------------------------------

    /// @notice A user who never opted in must be untouchable, even by an agent holding a
    ///         perfectly valid mandate on a position of their own.
    function test_AgentCannotActOnAPositionWithoutAMandate() public {
        vm.prank(agent);
        vault.setMandate(agentToken, _mandate(10 ether));

        vm.prank(agent);
        vault.recenter(agentToken, key, -50, 50, 0, _drainPayload(aliceToken, agent), block.timestamp + 60);

        assertEq(pm.getPositionLiquidity(aliceToken), ALICE_LIQUIDITY, "alice never opted in");
        assertEq(t0.balanceOf(agent), 0, "agent must not hold alice's token0");
        assertEq(t1.balanceOf(agent), 0, "agent must not hold alice's token1");
    }

    /// @notice Value leaving a position may only reach the position's owner.
    function test_ProceedsCanOnlyReachTheOwner() public {
        vm.prank(alice);
        vault.setMandate(aliceToken, _mandate(type(uint128).max));

        vm.prank(agent);
        vault.recenter(aliceToken, key, -50, 50, 1, _drainPayload(aliceToken, agent), block.timestamp + 60);

        assertEq(t0.balanceOf(agent), 0, "agent must not be a payout destination");
        assertEq(t1.balanceOf(agent), 0, "agent must not be a payout destination");
    }

    /// @notice Revoking ends the agent's authority. This is the exit the README promises.
    function test_RevokeStopsTheAgent() public {
        vm.startPrank(alice);
        vault.setMandate(aliceToken, _mandate(type(uint128).max));
        vault.revoke(aliceToken);
        vm.stopPrank();

        vm.prank(agent);
        vault.setMandate(agentToken, _mandate(10 ether));

        vm.prank(agent);
        vault.recenter(agentToken, key, -50, 50, 0, _drainPayload(aliceToken, agent), block.timestamp + 60);

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
        vm.expectRevert();
        vault.recenter(aliceToken, key, -50, 50, 1, _noop(), block.timestamp + 60);
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
        vm.expectRevert();
        vault.recenter(aliceToken, key, 100_000, 100_100, 1, _noop(), block.timestamp + 60);
    }

    /// @notice The size cap has to be measured from the position, not read off a number the
    ///         agent typed into the call.
    function test_SizeCapIsMeasuredNotDeclared() public {
        vm.prank(alice);
        vault.setMandate(aliceToken, _mandate(1_000));

        vm.prank(agent);
        vm.expectRevert();
        vault.recenter(aliceToken, key, -50, 50, 1, _noop(), block.timestamp + 60);
    }

    /// @notice `minImprovementBps` is committed and hashed into the user's mandate. It has to
    ///         mean something: an action that moves the range no closer to the market is churn.
    function test_ActionMustImproveOnWhereTheLiquidityAlreadySits() public {
        uint256 centred = pm.mintTo(alice, key, -50, 50, ALICE_LIQUIDITY);
        vm.prank(alice);
        vault.setMandate(centred, _mandate(type(uint128).max));

        vm.prank(agent);
        vm.expectRevert();
        vault.recenter(centred, key, -50, 50, 1, _noop(), block.timestamp + 60);
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
        vm.expectRevert();
        vault.upgradeToAndCall(address(v2), "");
    }

    /// @notice Scheduling an address with no code announces nothing a user could inspect.
    function test_UpgradeCannotBeScheduledForAnAddressWithNoCode() public {
        vm.prank(upgrader);
        vm.expectRevert();
        vault.scheduleUpgrade(makeAddr("not a contract"));
    }
}
