// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {HelicoAgent} from "../src/HelicoAgent.sol";
import {HelicoAppProxy} from "../src/HelicoAppProxy.sol";
import {IReceiver} from "../src/IReceiver.sol";

/// @dev An account that remembers who called it and with what, and can be told to refuse. The
///      real account's rules (`permittedVenue`, `msg.sender == agent`) are its own tests' business;
///      what this file measures is that the receiver turns a report into exactly one of the two
///      calls, sent from itself, with the report's numbers.
contract RecordingAccount {
    address public lastCaller;
    address public lastPool;
    address public lastAsset;
    uint256 public lastAmount;
    bool public lastWasSupply;
    uint256 public calls;
    bool public refuse;

    error Refused();

    function setRefuse(bool r) external {
        refuse = r;
    }

    function supplyIdle(address pool, address asset, uint256 amount) external {
        if (refuse) revert Refused();
        (lastCaller, lastPool, lastAsset, lastAmount, lastWasSupply) = (msg.sender, pool, asset, amount, true);
        calls++;
    }

    function withdrawIdle(address pool, address asset, uint256 amount) external {
        if (refuse) revert Refused();
        (lastCaller, lastPool, lastAsset, lastAmount, lastWasSupply) =
        (msg.sender, pool, asset, amount, false);
        calls++;
    }
}

contract HelicoAgentTest is Test {
    address constant FORWARDER = address(0xF0F0);
    address constant UPGRADER = address(0xA11CE);
    address constant WORKFLOW_OWNER = 0x6DCd7485aB17e0CBD0723b8435a35bb8d029439E;
    address constant POOL = 0xBBa798A61f0D7D1AE51466Fd4045Cd2Ea25c9A29;
    address constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    bytes32 constant WORKFLOW_ID = keccak256("helico-production@some-config");
    bytes10 constant WORKFLOW_NAME = bytes10("0123456789");
    bytes32 constant POLICY = 0xa48db44df37fd9f13ef34f8d390ffa6915b577c9e4dce80921c43f7a8b921af1;

    HelicoAgent implementation;
    HelicoAgent agent; // the proxy, which is the address accounts nominate and the DON writes to
    RecordingAccount account;

    event Carried(
        address indexed account,
        address indexed pool,
        address indexed asset,
        uint256 amount,
        bool supplied,
        bytes32 policyHash,
        bytes32 workflowId
    );
    event Held(bytes32 policyHash, bytes32 workflowId);

    function setUp() public {
        implementation = new HelicoAgent(FORWARDER, WORKFLOW_OWNER, UPGRADER);
        agent = HelicoAgent(address(new HelicoAppProxy(address(implementation))));
        account = new RecordingAccount();
        vm.warp(1_789_000_000);
    }

    // ---- helpers -----------------------------------------------------------------------------

    /// @dev What the production forwarder passes: 62 packed bytes of identity, then the two-byte
    ///      report id. `KeystoneForwarder.sol:305` slices exactly 64.
    function metadata64(address owner) internal pure returns (bytes memory) {
        return abi.encodePacked(WORKFLOW_ID, WORKFLOW_NAME, owner, bytes2(0x0001));
    }

    function report(bool act, address acct, uint256 amount, bool supply, uint256 deadline)
        internal
        pure
        returns (bytes memory)
    {
        HelicoAgent.IdleMove memory move = HelicoAgent.IdleMove({
            account: acct, pool: POOL, asset: USDC, amount: amount, supply: supply, deadline: deadline
        });
        return abi.encode(act, POLICY, move);
    }

    // ---- who may call ------------------------------------------------------------------------

    function test_OnlyTheForwarderMayCall() public {
        bytes memory r = report(true, address(account), 1, true, 0);
        vm.expectRevert(abi.encodeWithSelector(HelicoAgent.NotTheForwarder.selector, address(this)));
        agent.onReport(metadata64(WORKFLOW_OWNER), r);
        assertEq(account.calls(), 0, "nothing reached the account");
    }

    function test_AReportFromAnotherWorkflowOwnerIsRefused() public {
        address stranger = address(0xBAD);
        bytes memory r = report(true, address(account), 1, true, 0);
        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(HelicoAgent.NotTheWorkflowOwner.selector, stranger));
        agent.onReport(metadata64(stranger), r);
        assertEq(account.calls(), 0);
    }

    /// @dev The forwarder passes 64 bytes; older tooling passes 62. Both carry the owner at the
    ///      same offset, and a check for exactly 62 would have refused every production report.
    function test_MetadataOf62And64BytesBothDecode_ShorterIsRefused() public {
        bytes memory r = report(true, address(account), 1, true, 0);

        vm.prank(FORWARDER);
        agent.onReport(abi.encodePacked(WORKFLOW_ID, WORKFLOW_NAME, WORKFLOW_OWNER), r);
        assertEq(account.calls(), 1, "62 bytes");

        vm.prank(FORWARDER);
        agent.onReport(metadata64(WORKFLOW_OWNER), r);
        assertEq(account.calls(), 2, "64 bytes");

        bytes memory short = abi.encodePacked(WORKFLOW_ID, WORKFLOW_NAME, bytes19(0));
        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(HelicoAgent.MetadataTooShort.selector, 61));
        agent.onReport(short, r);
    }

    // ---- what a report does ------------------------------------------------------------------

    function test_ASupplyReportCallsSupplyIdle_FromTheAgent_WithTheReportsNumbers() public {
        vm.prank(FORWARDER);
        vm.expectEmit(true, true, true, true, address(agent));
        emit Carried(address(account), POOL, USDC, 400_064, true, POLICY, WORKFLOW_ID);
        agent.onReport(metadata64(WORKFLOW_OWNER), report(true, address(account), 400_064, true, 0));

        assertEq(account.calls(), 1);
        assertEq(account.lastCaller(), address(agent), "the account sees the agent contract as msg.sender");
        assertEq(account.lastPool(), POOL);
        assertEq(account.lastAsset(), USDC);
        assertEq(account.lastAmount(), 400_064);
        assertTrue(account.lastWasSupply());
    }

    function test_AWithdrawReportCallsWithdrawIdle() public {
        vm.prank(FORWARDER);
        agent.onReport(metadata64(WORKFLOW_OWNER), report(true, address(account), 12_345, false, 0));
        assertEq(account.calls(), 1);
        assertFalse(account.lastWasSupply());
        assertEq(account.lastAmount(), 12_345);
    }

    function test_AHoldReportTouchesNothingAndSaysSo() public {
        vm.prank(FORWARDER);
        vm.expectEmit(false, false, false, true, address(agent));
        emit Held(POLICY, WORKFLOW_ID);
        agent.onReport(metadata64(WORKFLOW_OWNER), report(false, address(account), 400_064, true, 0));
        assertEq(account.calls(), 0);
    }

    /// @dev `IReceiver` says a reverted report may be retransmitted later with more gas. A move
    ///      carries the deadline the enclave set, and past it the move is the receiver's to drop.
    function test_AnExpiredMoveIsDropped_ADeadlineOfZeroMeansNone() public {
        uint256 past = block.timestamp - 1;
        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(HelicoAgent.MoveExpired.selector, past, block.timestamp));
        agent.onReport(metadata64(WORKFLOW_OWNER), report(true, address(account), 1, true, past));

        vm.prank(FORWARDER);
        agent.onReport(metadata64(WORKFLOW_OWNER), report(true, address(account), 1, true, block.timestamp));
        assertEq(account.calls(), 1, "a deadline equal to now is still good");

        vm.prank(FORWARDER);
        agent.onReport(metadata64(WORKFLOW_OWNER), report(true, address(account), 1, true, 0));
        assertEq(account.calls(), 2, "zero is no deadline");
    }

    /// @dev The account's refusal is the receiver's refusal: a venue the owner never permitted
    ///      reverts in the account, and that revert must reach the forwarder so the transmission is
    ///      recorded as failed rather than succeeded-and-moved-nothing.
    function test_TheAccountsRefusalBubblesUp() public {
        account.setRefuse(true);
        vm.prank(FORWARDER);
        vm.expectRevert(RecordingAccount.Refused.selector);
        agent.onReport(metadata64(WORKFLOW_OWNER), report(true, address(account), 1, true, 0));
    }

    // ---- the wire format ---------------------------------------------------------------------

    /// @dev Bytes produced by `encodeReport` in `packages/plugins/cre/src/index.ts`, not written by
    ///      hand: the report the enclave will hand the DON, decoded by the contract that receives
    ///      it. If either side reorders a field, this is the test that says so.
    function test_TheReportIsDecodedTheWayTheEnclaveEncodesIt() public {
        bytes memory fromTheEnclave = hex"0000000000000000000000000000000000000000000000000000000000000001"
            hex"a48db44df37fd9f13ef34f8d390ffa6915b577c9e4dce80921c43f7a8b921af1"
            hex"0000000000000000000000000acdfa21a3cd075aee6583c8a8069f86ad3e4a39"
            hex"000000000000000000000000bba798a61f0d7d1ae51466fd4045cd2ea25c9a29"
            hex"000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e5831"
            hex"0000000000000000000000000000000000000000000000000000000000061ac0"
            hex"0000000000000000000000000000000000000000000000000000000000000001"
            hex"000000000000000000000000000000000000000000000000000000006aa3df67";
        assertEq(fromTheEnclave.length, 256, "eight words");

        // The account named in the vector is the live one; here the recorder stands in at that
        // address so the call has somewhere to land.
        address live = 0x0AcdFa21a3cD075aee6583c8A8069F86ad3e4a39;
        vm.etch(live, address(account).code);

        vm.prank(FORWARDER);
        vm.expectEmit(true, true, true, true, address(agent));
        emit Carried(live, POOL, USDC, 400_064, true, POLICY, WORKFLOW_ID);
        agent.onReport(metadata64(WORKFLOW_OWNER), fromTheEnclave);

        RecordingAccount r = RecordingAccount(live);
        assertEq(r.lastAmount(), 400_064);
        assertEq(r.lastPool(), POOL);
        assertEq(r.lastAsset(), USDC);
        assertTrue(r.lastWasSupply());
        assertEq(r.lastCaller(), address(agent));
    }

    // ---- the probe the forwarder makes first -------------------------------------------------

    /// @dev `KeystoneForwarder.route` asks `ERC165Checker.supportsInterface(receiver,
    ///      type(IReceiver).interfaceId)` before calling, and a wrong answer marks the receiver
    ///      invalid for that transmission with no retry. Same library, same id, same call.
    function test_TheForwardersProbeIsAnswered() public view {
        assertTrue(ERC165Checker.supportsInterface(address(agent), type(IReceiver).interfaceId));
        assertTrue(agent.supportsInterface(type(IERC165).interfaceId));
        assertFalse(agent.supportsInterface(0xdeadbeef));
        assertEq(type(IReceiver).interfaceId, bytes4(0x805f2132), "the selector of onReport(bytes,bytes)");
    }

    function test_NothingIsSettable_TheImmutablesReadThroughTheProxy() public view {
        assertEq(agent.FORWARDER(), FORWARDER);
        assertEq(agent.WORKFLOW_OWNER(), WORKFLOW_OWNER);
        assertEq(agent.UPGRADER(), UPGRADER);
        // No function on the ABI changes any of them: an upgrade is the only way, and it swaps
        // the code that carries them.
    }

    function test_ConstructorRefusesZero_ExceptForTheUpgrader() public {
        vm.expectRevert(HelicoAgent.ZeroAddress.selector);
        new HelicoAgent(address(0), WORKFLOW_OWNER, UPGRADER);
        vm.expectRevert(HelicoAgent.ZeroAddress.selector);
        new HelicoAgent(FORWARDER, address(0), UPGRADER);
        HelicoAgent frozen = new HelicoAgent(FORWARDER, WORKFLOW_OWNER, address(0));
        assertEq(frozen.UPGRADER(), address(0), "zero freezes; it is a setting, not a mistake");
    }

    // ---- upgrades ----------------------------------------------------------------------------

    /// @dev The upgrade changes the identities, because they are immutables of the code: this is
    ///      how a forwarder or workflow owner is ever changed, and it needs `UPGRADER`.
    function test_OnlyTheUpgraderMayReplaceTheCode_AndTheNewCodeBringsItsOwnIdentities() public {
        address newForwarder = address(0xF1F1);
        HelicoAgent next = new HelicoAgent(newForwarder, WORKFLOW_OWNER, UPGRADER);

        vm.expectRevert(abi.encodeWithSelector(HelicoAgent.NotUpgrader.selector, address(this)));
        agent.upgradeToAndCall(address(next), "");

        vm.prank(UPGRADER);
        agent.upgradeToAndCall(address(next), "");
        assertEq(agent.FORWARDER(), newForwarder, "the proxy now answers with the new code's forwarder");

        bytes memory r = report(true, address(account), 1, true, 0);
        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(HelicoAgent.NotTheForwarder.selector, FORWARDER));
        agent.onReport(metadata64(WORKFLOW_OWNER), r);
        vm.prank(newForwarder);
        agent.onReport(metadata64(WORKFLOW_OWNER), r);
        assertEq(account.calls(), 1);
    }

    function test_AnUpgradeToNothingIsRefused() public {
        vm.prank(UPGRADER);
        vm.expectRevert(abi.encodeWithSelector(HelicoAgent.ImplementationHasNoCode.selector, address(0xC0DE)));
        agent.upgradeToAndCall(address(0xC0DE), "");
    }

    function test_AZeroUpgraderFreezesTheProxy() public {
        HelicoAgent frozenImpl = new HelicoAgent(FORWARDER, WORKFLOW_OWNER, address(0));
        HelicoAgent frozen = HelicoAgent(address(new HelicoAppProxy(address(frozenImpl))));
        vm.prank(address(0));
        vm.expectRevert(abi.encodeWithSelector(HelicoAgent.NotUpgrader.selector, address(0)));
        frozen.upgradeToAndCall(address(implementation), "");
    }
}
