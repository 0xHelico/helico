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
        // Sent, not conjured. `vm.deal` sets a balance without exercising the transfer, and the
        // transfer is the half that can fail: an empty-calldata send lands on the proxy's
        // `receive`, and without one it is delegated to an implementation with no fallback.
        vm.deal(address(this), 1 ether);
        (bool sent,) = predicted.call{value: 1 ether}("");
        assertTrue(sent, "the address could be paid before it existed");

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

    /// @dev No delay, on purpose, for the length of the hackathon. `_authorizeUpgrade`'s docblock
    ///      says what that costs and that restoring it comes before real users.
    function test_AnUpgradeTakesEffectImmediately() public {
        address account = factory.open(owner);
        SecondAccount next = new SecondAccount(upgrader);

        vm.prank(upgrader);
        HelicoAccount(payable(account)).upgradeToAndCall(address(next), "");

        assertEq(SecondAccount(payable(account)).version(), 2);
    }

    function test_TheOwnerCanRefuseAutomaticUpgradesForGood() public {
        address account = factory.open(owner);
        SecondAccount next = new SecondAccount(upgrader);

        vm.prank(owner);
        HelicoAccount(payable(account)).refuseAutoUpgrade();

        vm.prank(upgrader);
        vm.expectRevert(abi.encodeWithSelector(HelicoAccount.NotOwnerOrUpgrader.selector, upgrader));
        HelicoAccount(payable(account)).upgradeToAndCall(address(next), "");

        // The owner is not locked out of their own code.
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

    function test_AStrangerCannotUpgrade() public {
        address account = factory.open(owner);
        SecondAccount next = new SecondAccount(upgrader);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(HelicoAccount.NotOwnerOrUpgrader.selector, stranger));
        HelicoAccount(payable(account)).upgradeToAndCall(address(next), "");
    }

    function test_AnEmptyImplementationCannotBeInstalled() public {
        address account = factory.open(owner);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(HelicoAccount.ImplementationHasNoCode.selector, address(0xDEAD))
        );
        HelicoAccount(payable(account)).upgradeToAndCall(address(0xDEAD), "");
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

/// @notice The flow the frontend actually needs: the user only ever sends one transaction.
///
/// @dev Named separately because it is a product claim, not a unit. If this file is green, the
///      seamless path is real; if somebody changes `execute`'s caller check or makes `open`
///      permissioned, this is what goes red.
contract HelicoAccountSeamlessTest is Test {
    HelicoAccount implementation;
    HelicoAccountFactory factory;
    TestToken token;

    address user = address(0x115E2);
    address relayer = address(0xFEE7A);

    function setUp() public {
        implementation = new HelicoAccount(address(0xC2E));
        factory = new HelicoAccountFactory(address(implementation));
        token = new TestToken("Token", "TKN");
    }

    function test_TheUserSendsOneTransactionAndNeverSeesTheAccountBeingCreated() public {
        // The frontend knows the address the moment the wallet connects, before anything exists.
        address account = factory.accountFor(user);
        assertFalse(factory.isOpen(user));

        // Our relayer opens it, on our gas, while the user is still typing. Opening grants the
        // relayer nothing: the owner is fixed by the address itself.
        vm.prank(relayer);
        factory.open(user);
        assertTrue(factory.isOpen(user));
        assertEq(HelicoAccount(payable(account)).owner(), user, "the relayer did not become the owner");

        // The user's first and only transaction is their actual command. No intermediary, so
        // `msg.sender` is the user and `execute`'s check passes.
        token.mint(account, 100e18);
        vm.prank(user);
        HelicoAccount(payable(account))
            .execute(address(token), 0, abi.encodeWithSignature("transfer(address,uint256)", user, 100e18));

        assertEq(token.balanceOf(user), 100e18);
    }

    function test_TheRelayerCannotActAsTheUserItOpenedFor() public {
        address account = factory.open(user);
        token.mint(account, 100e18);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(HelicoAccount.NotOwner.selector, relayer));
        HelicoAccount(payable(account))
            .execute(address(token), 0, abi.encodeWithSignature("transfer(address,uint256)", relayer, 100e18));
    }
}
