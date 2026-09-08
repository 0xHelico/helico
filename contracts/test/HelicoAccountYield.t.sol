// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {HelicoAccount} from "../src/HelicoAccount.sol";
import {HelicoAccountFactory} from "../src/HelicoAccountFactory.sol";
import {HelicoAccountProxy} from "../src/HelicoAccountProxy.sol";
import {MockLendingPool, MockReceipt} from "./MandateVenues.sol";
import {TestToken} from "./MandateTakers.sol";

/// @notice What the agent can do, and — mostly — what it cannot.
///
/// @dev The product claim is that CRE decides where a user's idle capital sits. The security
///      claim is that deciding is all it can do. Most of this file is the second claim, because
///      an authority is defined by its edges rather than by its happy path.
contract HelicoAccountYieldTest is Test {
    HelicoAccount implementation;
    HelicoAccountFactory factory;
    TestToken token;
    MockLendingPool pool;
    MockReceipt receipt;

    address owner = address(0xA11CE);
    address agent = address(0xC2E);
    address stranger = address(0xBAD);
    address account;

    uint256 constant FUNDED = 1_000e18;

    function setUp() public {
        vm.warp(1_000_000);
        implementation = new HelicoAccount(address(0));
        factory = new HelicoAccountFactory(address(implementation));
        token = new TestToken("Token", "TKN");
        pool = new MockLendingPool();
        receipt = pool.list(address(token), "aTKN");

        account = factory.open(owner);
        token.mint(account, FUNDED);

        vm.startPrank(owner);
        HelicoAccount(payable(account)).setAgent(agent);
        HelicoAccount(payable(account)).permitVenue(address(pool), true);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------------------------
    // What it is for
    // ------------------------------------------------------------------------------------

    function test_TheAgentPutsIdleCapitalToWorkAndTakesItBack() public {
        vm.prank(agent);
        HelicoAccount(payable(account)).supplyIdle(address(pool), address(token), 600e18);

        assertEq(token.balanceOf(account), 400e18, "what stayed idle");
        assertEq(receipt.balanceOf(account), 600e18, "what went to work, still the account's");

        vm.prank(agent);
        HelicoAccount(payable(account)).withdrawIdle(address(pool), address(token), 600e18);

        assertEq(token.balanceOf(account), FUNDED, "and it came back");
        assertEq(receipt.balanceOf(account), 0);
    }

    /// @dev An allowance outlives the nomination that justified it, so revoking an agent has to
    ///      actually revoke something.
    function test_NoStandingAllowanceSurvivesTheCall() public {
        vm.prank(agent);
        HelicoAccount(payable(account)).supplyIdle(address(pool), address(token), 600e18);

        assertEq(token.allowance(account, address(pool)), 0, "nothing left standing");
    }

    // ------------------------------------------------------------------------------------
    // The edges — what the agent cannot reach
    // ------------------------------------------------------------------------------------

    function test_TheAgentCannotIntroduceItsOwnVenue() public {
        MockLendingPool rogue = new MockLendingPool();
        rogue.list(address(token), "rTKN");

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(HelicoAccount.VenueNotPermitted.selector, address(rogue)));
        HelicoAccount(payable(account)).supplyIdle(address(rogue), address(token), 600e18);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(HelicoAccount.NotOwner.selector, agent));
        HelicoAccount(payable(account)).permitVenue(address(rogue), true);
    }

    function test_TheAgentCannotMakeAGeneralCall() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(HelicoAccount.NotOwner.selector, agent));
        HelicoAccount(payable(account))
            .execute(address(token), 0, abi.encodeWithSignature("transfer(address,uint256)", agent, FUNDED));
        assertEq(token.balanceOf(agent), 0);
    }

    function test_TheAgentCannotUseTheEscapeHatch() public {
        address[] memory tokens = new address[](1);
        tokens[0] = address(token);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(HelicoAccountProxy.NotOwner.selector, agent));
        HelicoAccountProxy(payable(account)).escape(tokens);
    }

    function test_TheAgentCannotUpgradeTheAccount() public {
        HelicoAccount next = new HelicoAccount(address(0));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(HelicoAccount.NotOwnerOrUpgrader.selector, agent));
        HelicoAccount(payable(account)).upgradeToAndCall(address(next), "");
    }

    function test_TheAgentCannotNominateAnotherAgent() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(HelicoAccount.NotOwner.selector, agent));
        HelicoAccount(payable(account)).setAgent(stranger);
    }

    function test_AStrangerCannotMoveCapitalAtAll() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(HelicoAccount.NotOwnerOrAgent.selector, stranger));
        HelicoAccount(payable(account)).supplyIdle(address(pool), address(token), 600e18);
    }

    // ------------------------------------------------------------------------------------
    // Taking it back
    // ------------------------------------------------------------------------------------

    function test_RevokingTheAgentTakesEffectAtOnce() public {
        vm.prank(agent);
        HelicoAccount(payable(account)).supplyIdle(address(pool), address(token), 100e18);

        vm.prank(owner);
        HelicoAccount(payable(account)).setAgent(address(0));

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(HelicoAccount.NotOwnerOrAgent.selector, agent));
        HelicoAccount(payable(account)).supplyIdle(address(pool), address(token), 100e18);
    }

    function test_RemovingAVenueStopsFurtherSupplyButNotWithdrawalByTheOwner() public {
        vm.prank(agent);
        HelicoAccount(payable(account)).supplyIdle(address(pool), address(token), 600e18);

        vm.prank(owner);
        HelicoAccount(payable(account)).permitVenue(address(pool), false);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(HelicoAccount.VenueNotPermitted.selector, address(pool)));
        HelicoAccount(payable(account)).supplyIdle(address(pool), address(token), 100e18);

        // What the name of this test promises: the call that exists to bring capital home still
        // works for the owner after the venue is revoked. Revoking is how an owner says they want
        // out, so it must not be what stops them getting out.
        vm.prank(owner);
        HelicoAccount(payable(account)).withdrawIdle(address(pool), address(token), 600e18);
        assertEq(token.balanceOf(account), 1000e18, "all of it came home");
        assertEq(receipt.balanceOf(account), 0, "and the position is closed");
    }

    function test_TheAgentUnwindsAVenueTheOwnerJustRevoked() public {
        vm.prank(agent);
        HelicoAccount(payable(account)).supplyIdle(address(pool), address(token), 600e18);

        vm.prank(owner);
        HelicoAccount(payable(account)).permitVenue(address(pool), false);

        // Revoking is not a pause. The owner said they want out of this venue, and the agent is
        // the one awake to act on it — so the way out stays open while the way in closes.
        vm.prank(agent);
        HelicoAccount(payable(account)).withdrawIdle(address(pool), address(token), 600e18);
        assertEq(token.balanceOf(account), 1000e18, "the agent brought it home");

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(HelicoAccount.VenueNotPermitted.selector, address(pool)));
        HelicoAccount(payable(account)).supplyIdle(address(pool), address(token), 100e18);
    }

    function test_TheAgentCannotReachAVenueTheOwnerNeverNamed() public {
        MockLendingPool stranger = new MockLendingPool();

        // The half of the check that is not a convenience. `withdrawIdle` makes this account call
        // an address chosen by the caller, with a fixed selector — bounded only by the set of
        // venues the owner has named at some point. A venue that was never named is not in it,
        // revoked or otherwise.
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(HelicoAccount.VenueNotPermitted.selector, address(stranger)));
        HelicoAccount(payable(account)).withdrawIdle(address(stranger), address(token), 1);

        // And the owner is not bounded by it, because `execute` already is not.
        assertTrue(HelicoAccount(payable(account)).venueEverPermitted(address(pool)));
        assertFalse(HelicoAccount(payable(account)).venueEverPermitted(address(stranger)));
    }

    function test_TheEscapeHatchStillMovesThePositionItself() public {
        vm.prank(agent);
        HelicoAccount(payable(account)).supplyIdle(address(pool), address(token), 600e18);

        vm.prank(owner);
        HelicoAccount(payable(account)).permitVenue(address(pool), false);

        address[] memory tokens = new address[](1);
        tokens[0] = address(receipt);
        vm.prank(owner);
        HelicoAccountProxy(payable(account)).escape(tokens);
        assertEq(receipt.balanceOf(owner), 600e18, "the position itself is still the owner's");
    }

    function test_TheOwnerCanMoveCapitalWithoutAnAgent() public {
        vm.prank(owner);
        HelicoAccount(payable(account)).setAgent(address(0));

        vm.prank(owner);
        HelicoAccount(payable(account)).supplyIdle(address(pool), address(token), 600e18);
        assertEq(receipt.balanceOf(account), 600e18);
    }
}
