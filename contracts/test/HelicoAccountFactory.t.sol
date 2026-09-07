// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {HelicoAccount} from "../src/HelicoAccount.sol";
import {HelicoAccountFactory} from "../src/HelicoAccountFactory.sol";
import {HelicoAccountProxy} from "../src/HelicoAccountProxy.sol";
import {TestToken} from "./MandateTakers.sol";

/// @notice An implementation that wants the account for itself.
/// @dev It declares `OWNER()` and `escape(address[])` — the two selectors the proxy keeps — and
///      answers both in the attacker's favour. If the proxy did not dispatch its own functions
///      first, upgrading to this would take the account and delete the way out.
contract HostileAccount is HelicoAccount {
    address public immutable THIEF;

    constructor(address upgrader, address thief) HelicoAccount(upgrader) {
        THIEF = thief;
    }

    function OWNER() external view returns (address) {
        return THIEF;
    }

    function escape(address[] calldata) external view {
        revert("no way out");
    }
}

/// @notice An implementation that is merely different, for testing the upgrade mechanics.
contract SecondAccount is HelicoAccount {
    constructor(address upgrader) HelicoAccount(upgrader) {}

    function version() external pure returns (uint256) {
        return 2;
    }
}

contract HelicoAccountFactoryTest is Test {
    HelicoAccount implementation;
    HelicoAccountFactory factory;
    TestToken token;

    address owner = address(0xA11CE);
    address upgrader = address(0xC2E);
    address stranger = address(0xBAD);

    function setUp() public {
        vm.warp(1_000_000);
        implementation = new HelicoAccount(upgrader);
        factory = new HelicoAccountFactory(address(implementation));
        token = new TestToken("Token", "TKN");
    }

    // ------------------------------------------------------------------------------------
    // An address before there is a contract
    // ------------------------------------------------------------------------------------

    function test_AnAccountAddressIsKnownBeforeTheAccountExists() public {
        address predicted = factory.accountFor(owner);

        assertEq(predicted.code.length, 0, "nothing is deployed yet");
        assertFalse(factory.isOpen(owner));

        address opened = factory.open(owner);

        assertEq(opened, predicted, "the address was knowable in advance");
        assertGt(opened.code.length, 0);
        assertTrue(factory.isOpen(owner));
    }

    /// @dev The reason counterfactual addresses are worth the trouble: someone can be paid before
    ///      they have ever sent a transaction, and the money is theirs when they arrive.
    function test_TokensSentBeforeTheAccountExistsAreStillTheOwners() public {
        address predicted = factory.accountFor(owner);
        token.mint(predicted, 500e18);
        vm.deal(predicted, 1 ether);

        factory.open(owner);

        address[] memory tokens = new address[](1);
        tokens[0] = address(token);
        vm.prank(owner);
        HelicoAccountProxy(payable(predicted)).escape(tokens);

        assertEq(token.balanceOf(owner), 500e18, "tokens that arrived early came home");
        assertEq(owner.balance, 1 ether, "so did the native currency");
    }

    function test_OpeningTwiceReturnsTheSameAccountRatherThanReverting() public {
        address first = factory.open(owner);
        address second = factory.open(owner);
        assertEq(first, second);
    }

    /// @dev Opening an account for somebody grants nothing: the owner is baked into the address,
    ///      so a stranger who opens it has opened exactly the account the owner would have.
    function test_AnyoneMayOpenAnAccountForAnyone() public {
        vm.prank(stranger);
        address account = factory.open(owner);

        assertEq(HelicoAccountProxy(payable(account)).OWNER(), owner);
        assertEq(HelicoAccount(payable(account)).owner(), owner);
    }

    function test_TwoOwnersGetTwoAccounts() public {
        assertTrue(factory.accountFor(owner) != factory.accountFor(stranger));
    }

    // ------------------------------------------------------------------------------------
    // The door that cannot be closed
    // ------------------------------------------------------------------------------------

    function test_NobodyButTheOwnerCanEscape() public {
        address account = factory.open(owner);
        token.mint(account, 100e18);

        address[] memory tokens = new address[](1);
        tokens[0] = address(token);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(HelicoAccountProxy.NotOwner.selector, stranger));
        HelicoAccountProxy(payable(account)).escape(tokens);
    }

    /// @dev The load-bearing test for the whole architecture. An implementation that declares both
    ///      of the proxy's selectors, and answers them in an attacker's favour, is installed — and
    ///      the owner still gets everything back.
    function test_AnUpgradeCannotTakeTheAccountOrDeleteTheWayOut() public {
        address account = factory.open(owner);
        token.mint(account, 100e18);

        HostileAccount hostile = new HostileAccount(upgrader, stranger);

        vm.prank(owner);
        HelicoAccount(payable(account)).scheduleUpgrade(address(hostile));
        vm.warp(block.timestamp + 2 days);
        vm.prank(owner);
        HelicoAccount(payable(account)).upgradeToAndCall(address(hostile), "");

        // The hostile code is installed and running.
        assertEq(HostileAccount(payable(account)).THIEF(), stranger, "the upgrade did land");

        // And neither of the two selectors it declared ever reaches it.
        assertEq(HelicoAccountProxy(payable(account)).OWNER(), owner, "ownership did not move");

        address[] memory tokens = new address[](1);
        tokens[0] = address(token);
        vm.prank(owner);
        HelicoAccountProxy(payable(account)).escape(tokens);

        assertEq(token.balanceOf(owner), 100e18, "the owner still got everything back");
    }

    // ------------------------------------------------------------------------------------
    // Upgrades: announced, delayed, cancellable, pinned, refusable
    // ------------------------------------------------------------------------------------

    function test_AnUpgradeWaitsForTheDelay() public {
        address account = factory.open(owner);
        SecondAccount next = new SecondAccount(upgrader);

        vm.prank(upgrader);
        HelicoAccount(payable(account)).scheduleUpgrade(address(next));

        vm.prank(upgrader);
        vm.expectRevert();
        HelicoAccount(payable(account)).upgradeToAndCall(address(next), "");

        vm.warp(block.timestamp + 2 days);
        vm.prank(upgrader);
        HelicoAccount(payable(account)).upgradeToAndCall(address(next), "");
        assertEq(SecondAccount(payable(account)).version(), 2);
    }

    function test_TheOwnerCanCancelDuringTheDelay() public {
        address account = factory.open(owner);
        SecondAccount next = new SecondAccount(upgrader);

        vm.prank(upgrader);
        HelicoAccount(payable(account)).scheduleUpgrade(address(next));

        vm.prank(owner);
        HelicoAccount(payable(account)).cancelUpgrade(address(next));

        vm.warp(block.timestamp + 2 days);
        vm.prank(upgrader);
        vm.expectRevert(HelicoAccount.UpgradeNotScheduled.selector);
        HelicoAccount(payable(account)).upgradeToAndCall(address(next), "");
    }

    function test_TheOwnerCanRefuseAutomaticUpgradesForGood() public {
        address account = factory.open(owner);
        SecondAccount next = new SecondAccount(upgrader);

        vm.prank(owner);
        HelicoAccount(payable(account)).refuseAutoUpgrade();

        vm.prank(upgrader);
        vm.expectRevert(abi.encodeWithSelector(HelicoAccount.NotOwnerOrUpgrader.selector, upgrader));
        HelicoAccount(payable(account)).scheduleUpgrade(address(next));

        // The owner is not locked out of their own code.
        vm.prank(owner);
        HelicoAccount(payable(account)).scheduleUpgrade(address(next));
        vm.warp(block.timestamp + 2 days);
        vm.prank(owner);
        HelicoAccount(payable(account)).upgradeToAndCall(address(next), "");
        assertEq(SecondAccount(payable(account)).version(), 2);
    }

    function test_RefusingTwiceIsRefused() public {
        address account = factory.open(owner);
        vm.startPrank(owner);
        HelicoAccount(payable(account)).refuseAutoUpgrade();
        vm.expectRevert(HelicoAccount.AutoUpgradeAlreadyRefused.selector);
        HelicoAccount(payable(account)).refuseAutoUpgrade();
        vm.stopPrank();
    }

    function test_AStrangerCanNeitherScheduleNorUpgrade() public {
        address account = factory.open(owner);
        SecondAccount next = new SecondAccount(upgrader);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(HelicoAccount.NotOwnerOrUpgrader.selector, stranger));
        HelicoAccount(payable(account)).scheduleUpgrade(address(next));
    }

    function test_AnUpgradeExpiresIfItIsNotRun() public {
        address account = factory.open(owner);
        SecondAccount next = new SecondAccount(upgrader);

        vm.prank(upgrader);
        HelicoAccount(payable(account)).scheduleUpgrade(address(next));

        vm.warp(block.timestamp + 2 days + 7 days + 1);
        vm.prank(upgrader);
        vm.expectRevert();
        HelicoAccount(payable(account)).upgradeToAndCall(address(next), "");
    }

    function test_AnEmptyImplementationCannotBeScheduled() public {
        address account = factory.open(owner);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(HelicoAccount.ImplementationHasNoCode.selector, address(0xDEAD))
        );
        HelicoAccount(payable(account)).scheduleUpgrade(address(0xDEAD));
    }

    // ------------------------------------------------------------------------------------
    // Acting as the account
    // ------------------------------------------------------------------------------------

    function test_TheOwnerCanActAsTheAccountAndNobodyElseCan() public {
        address account = factory.open(owner);
        token.mint(account, 100e18);

        bytes memory transfer = abi.encodeWithSignature("transfer(address,uint256)", owner, 40e18);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(HelicoAccount.NotOwner.selector, stranger));
        HelicoAccount(payable(account)).execute(address(token), 0, transfer);

        vm.prank(owner);
        HelicoAccount(payable(account)).execute(address(token), 0, transfer);
        assertEq(token.balanceOf(owner), 40e18);
    }
}
