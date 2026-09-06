// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {HelicoVault} from "../src/HelicoVault.sol";
import {IReceiver} from "../src/IReceiver.sol";
import {Mandate, MandateLib, PoolKey} from "../src/Mandate.sol";
import {
    MockERC20,
    MockPoolManager,
    MockStateView,
    RealisticPositionManager
} from "./RealisticPositionManager.sol";

/// @notice The delivery path: the enclave decides, the DON signs, the forwarder calls.
///
/// @dev The forwarder checks `f + 1` DON signatures over the report before it ever reaches this
///      contract, and the vault cannot re-check them. So `msg.sender == forwarder` is the entire
///      security boundary of `onReport`, and most of this file is about that one line: who may
///      call it, what happens the rest of the time, and what the vault still refuses even when
///      the caller is right.
contract ForwarderReportTest is Test {
    using MandateLib for PoolKey;

    HelicoVault vault;
    RealisticPositionManager pm;
    MockStateView stateView;
    MockPoolManager poolManager;
    MockERC20 t0;
    MockERC20 t1;

    address admin = makeAddr("admin");
    address user = makeAddr("user");
    address forwarder = makeAddr("forwarder");
    address stranger = makeAddr("stranger");
    address guardian = makeAddr("guardian");

    PoolKey poolKey;
    Mandate mandate;
    uint256 tokenId;

    uint128 constant LIQUIDITY = 1_000_000;

    function setUp() public {
        t0 = new MockERC20();
        t1 = new MockERC20();
        pm = new RealisticPositionManager(t0, t1);
        stateView = new MockStateView();
        poolManager = new MockPoolManager();

        HelicoVault impl = new HelicoVault();
        bytes memory init = abi.encodeCall(
            HelicoVault.initialize, (admin, address(pm), address(stateView), address(poolManager))
        );
        vault = HelicoVault(payable(address(new ERC1967Proxy(address(impl), init))));

        bytes32 guardianRole = vault.GUARDIAN_ROLE();
        vm.startPrank(admin);
        vault.grantRole(guardianRole, guardian);
        vault.setForwarder(forwarder);
        vm.stopPrank();

        poolKey = PoolKey({
            currency0: address(t0), currency1: address(t1), fee: 3000, tickSpacing: 10, hooks: address(0)
        });
        stateView.setTick(poolKey.hashPoolKey(), 0);

        tokenId = pm.mintTo(user, poolKey, -300, -200, LIQUIDITY);
        vm.startPrank(user);
        pm.setApprovalForAll(address(vault), true);
        mandate = Mandate({
            poolId: poolKey.hashPoolKey(),
            rangeWidthTicks: 100,
            minImprovementBps: 500,
            cooldownSeconds: 1 hours,
            maxLiquidity: LIQUIDITY,
            expiry: uint64(block.timestamp + 30 days),
            minRetainedBps: 9_000
        });
        vault.setMandate(tokenId, mandate);
        vm.stopPrank();
    }

    function _params() internal view returns (HelicoVault.RecenterParams memory) {
        return HelicoVault.RecenterParams({
            owner: user,
            tickLower: -50,
            tickUpper: 50,
            liquidityToMint: LIQUIDITY,
            amount0Min: 0,
            amount1Min: 0,
            amount0Max: type(uint128).max,
            amount1Max: type(uint128).max,
            zeroForOne: false,
            amountIn: 0,
            minAmountOut: 0,
            deadline: block.timestamp + 60
        });
    }

    /// @dev `abi.encode(bool act, bytes32 mandateHash, RecenterParams p)` — the tuple
    ///      `encodeReport` in `packages/plugins/cre/src/index.ts` produces. If these two ever
    ///      disagree, every report the enclave writes reverts on decode with nothing to read.
    function _report(bool act, bytes32 hash_, HelicoVault.RecenterParams memory p)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(act, hash_, p);
    }

    // --- the boundary --------------------------------------------------------------------

    function test_TheForwarderCanMoveAPosition() public {
        uint256 expected = pm.nextTokenId();

        vm.prank(forwarder);
        vault.onReport("", _report(true, MandateLib.hash(mandate), _params()));

        assertEq(pm.ownerOf(expected), user, "the new position went to its owner");
        assertEq(vault.positionOf(user), expected, "and the account follows it");
    }

    /// @notice The one line the whole path rests on.
    function test_NobodyElseCan() public {
        bytes memory report = _report(true, MandateLib.hash(mandate), _params());

        address[3] memory callers = [stranger, admin, user];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(HelicoVault.NotForwarder.selector);
            vault.onReport("", report);
        }
    }

    /// @notice A vault whose forwarder was never set refuses every report, without needing a
    ///         zero check: `msg.sender` cannot be the zero address.
    function test_AVaultWithNoForwarderSetRefusesEverything() public {
        HelicoVault impl = new HelicoVault();
        bytes memory init = abi.encodeCall(
            HelicoVault.initialize, (admin, address(pm), address(stateView), address(poolManager))
        );
        HelicoVault fresh = HelicoVault(payable(address(new ERC1967Proxy(address(impl), init))));
        assertEq(fresh.forwarder(), address(0), "unset by default");

        vm.prank(forwarder);
        vm.expectRevert(HelicoVault.NotForwarder.selector);
        fresh.onReport("", _report(true, MandateLib.hash(mandate), _params()));
    }

    function test_OnlyAnAdminCanPointTheVaultAtAForwarder() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, bytes32(0)
            )
        );
        vault.setForwarder(stranger);

        vm.prank(admin);
        vault.setForwarder(stranger);
        assertEq(vault.forwarder(), stranger, "an admin may swap it without a new vault");
    }

    /// @dev Chainlink's forwarder delivers to an `IReceiver`, and its receivers advertise that
    ///      through ERC-165.
    function test_TheVaultSaysItIsAReceiver() public view {
        assertTrue(vault.supportsInterface(type(IReceiver).interfaceId), "IReceiver");
        assertTrue(vault.supportsInterface(0x01ffc9a7), "and still ERC-165 itself");
    }

    /// @notice The report the enclave writes, decoded by the contract that receives it.
    ///
    /// @dev The bytes below were produced by `encodeReport` in
    ///      `packages/plugins/cre/src/index.ts`, not by this contract, so neither side is
    ///      checking its own arithmetic:
    ///
    ///        encodeReport(true, 0x134be6bb…6225, { owner: 0x…A1, tickLower: -600, … })
    ///
    ///      `RecenterParams` is a static struct, so the tuple encodes flat with no offset word.
    ///      Reorder a field on either side and the decode below silently produces different
    ///      numbers rather than reverting — which is exactly the failure this pins down.
    function test_DecodesTheReportTheEnclaveEncodes() public pure {
        bytes memory report =
            hex"0000000000000000000000000000000000000000000000000000000000000001134be6bb4e1c442551c22dfe96cb5b7c3c31babb386e2e9a051e57ee329a622500000000000000000000000000000000000000000000000000000000000000a1fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffda8000000000000000000000000000000000000000000000000000000000000025800000000000000000000000000000000000000000000000000000000075bcd1500000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000022b000000000000000000000000000000000000000000000000000000000000029a000000000000000000000000000000000000000000000000000000006b49d200";

        (bool act, bytes32 mandateHash, HelicoVault.RecenterParams memory p) =
            abi.decode(report, (bool, bytes32, HelicoVault.RecenterParams));

        assertTrue(act);
        assertEq(mandateHash, 0x134be6bb4e1c442551c22dfe96cb5b7c3c31babb386e2e9a051e57ee329a6225);
        assertEq(p.owner, address(0x00000000000000000000000000000000000000A1));
        assertEq(p.tickLower, -600);
        assertEq(p.tickUpper, 600);
        assertEq(p.liquidityToMint, 123_456_789);
        assertEq(p.amount0Min, 1);
        assertEq(p.amount1Min, 2);
        assertEq(p.amount0Max, 3);
        assertEq(p.amount1Max, 4);
        assertFalse(p.zeroForOne);
        assertEq(p.amountIn, 555);
        assertEq(p.minAmountOut, 666);
        assertEq(p.deadline, 1_800_000_000);
    }

    // --- what the vault still refuses ----------------------------------------------------

    /// @notice A verdict decided against terms the user has since replaced.
    function test_AReportAgainstReplacedTermsIsRefused() public {
        bytes32 old = MandateLib.hash(mandate);

        Mandate memory changed = mandate;
        changed.rangeWidthTicks = 200;
        vm.prank(user);
        vault.setMandate(tokenId, changed);

        vm.prank(forwarder);
        vm.expectRevert(HelicoVault.MandateChanged.selector);
        vault.onReport("", _report(true, old, _params()));
    }

    /// @notice The forwarder blocks a repeat of the same transmission, but not a report that is
    ///         simply old. The deadline inside the report is what does, and it is checked here
    ///         and nowhere in v4.
    function test_AStaleReportIsRefusedByItsOwnDeadline() public {
        bytes memory report = _report(true, MandateLib.hash(mandate), _params());

        vm.warp(block.timestamp + 61);

        vm.prank(forwarder);
        vm.expectRevert(HelicoVault.AuthorisationExpired.selector);
        vault.onReport("", report);
    }

    /// @notice The workflow does not write a hold, so this is the case that should never arrive.
    ///         It is honoured anyway: a report that says do nothing must move nothing.
    function test_AHoldMovesNothing() public {
        uint256 before = vault.positionOf(user);

        vm.prank(forwarder);
        vault.onReport("", _report(false, MandateLib.hash(mandate), _params()));

        assertEq(vault.positionOf(user), before, "the position is where it was");
        assertEq(pm.ownerOf(before), user, "and still the user's");
    }

    function test_APausedVaultRefusesReports() public {
        vm.prank(guardian);
        vault.pause();

        vm.prank(forwarder);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.onReport("", _report(true, MandateLib.hash(mandate), _params()));
    }

    /// @notice The cooldown is the third answer to a stale report: even a fresh, well-formed
    ///         one cannot move the same position twice in a row.
    function test_ASecondReportInsideTheCooldownIsRefused() public {
        vm.prank(forwarder);
        vault.onReport("", _report(true, MandateLib.hash(mandate), _params()));

        vm.prank(forwarder);
        vm.expectRevert(HelicoVault.CooldownNotElapsed.selector);
        vault.onReport("", _report(true, MandateLib.hash(mandate), _params()));
    }
}
