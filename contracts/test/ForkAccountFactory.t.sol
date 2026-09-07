// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {DeployAccountFactory} from "../script/DeployAccountFactory.s.sol";
import {HelicoAccount} from "../src/HelicoAccount.sol";
import {HelicoAccountFactory} from "../src/HelicoAccountFactory.sol";
import {HelicoAccountProxy} from "../src/HelicoAccountProxy.sol";

/// @notice The account architecture against live Arbitrum, through the deploy script's own door.
///
/// @dev The unit tests use a token this repo wrote, which is the friendliest ERC-20 that exists.
///      USDC on Arbitrum is a proxy with its own upgrade history and its own opinions, and it is
///      what these accounts will actually hold. Everything here runs through
///      `DeployAccountFactory.deploy` rather than constructing the contracts directly, so a
///      rehearsal cannot pass through a door production does not use.
contract ForkAccountFactoryTest is Test {
    address constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    address constant AAVE_POOL = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;
    address constant AUSDC = 0x724dc807b04555b71ed48a6896b6F41593b8C637;
    address constant USDC_WHALE = 0x47c031236e19d024b42f8AE6780E44A573170703;

    DeployAccountFactory script;
    HelicoAccount implementation;
    HelicoAccountFactory factory;

    address owner;
    uint256 ownerKey;
    address relayer = address(0xFEE7A);
    address cre = address(0xC2E);
    address payee = address(0xBEEF);

    bool forked;

    function setUp() public {
        try vm.createSelectFork("arbitrum") {
            forked = true;
        } catch {
            emit log("no endpoint: set ARBITRUM_RPC_URL to run this fork suite");
            return;
        }

        (owner, ownerKey) = makeAddrAndKey("fork-owner");

        script = new DeployAccountFactory();
        (implementation, factory) = script.deploy(address(0xC2E));
    }

    modifier onlyForked() {
        if (!forked) return;
        _;
    }

    function test_TheDeployedFactoryPredictsTheAddressItProduces() public onlyForked {
        address predicted = factory.accountFor(owner);
        assertEq(predicted.code.length, 0);

        address opened = factory.open(owner);

        assertEq(opened, predicted, "the counterfactual promise holds on a live chain");
        assertEq(HelicoAccount(payable(opened)).owner(), owner);
        assertEq(factory.IMPLEMENTATION(), address(implementation));
    }

    /// @dev Real USDC, arriving at an address that does not exist yet, and leaving through the
    ///      escape hatch. This is the sequence a user's money actually takes.
    function test_RealUsdcSentBeforeTheAccountExistsCanStillBeEscaped() public onlyForked {
        address predicted = factory.accountFor(owner);

        vm.prank(USDC_WHALE);
        IERC20(USDC).transfer(predicted, 1_000e6);
        assertEq(IERC20(USDC).balanceOf(predicted), 1_000e6, "paid before it existed");

        factory.open(owner);

        address[] memory tokens = new address[](1);
        tokens[0] = USDC;
        vm.prank(owner);
        HelicoAccountProxy(payable(predicted)).escape(tokens);

        assertEq(IERC20(USDC).balanceOf(owner), 1_000e6, "and it came home");
        assertEq(IERC20(USDC).balanceOf(predicted), 0);
    }

    /// @dev The whole product claim, on a live chain: the owner signs once, sends nothing, and a
    ///      relayer opens the account and moves real USDC in a single transaction.
    function test_OneSignatureOpensTheAccountAndMovesRealUsdc() public onlyForked {
        address account = factory.accountFor(owner);

        vm.prank(USDC_WHALE);
        IERC20(USDC).transfer(account, 500e6);

        uint256 deadline = block.timestamp + 1 hours;
        bytes memory data = abi.encodeWithSignature("transfer(address,uint256)", payee, 200e6);
        bytes32 digest = factory.executeDigest(owner, USDC, 0, data, 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, digest);

        vm.startPrank(relayer);
        factory.open(owner);
        HelicoAccount(payable(account))
            .executeWithSignature(USDC, 0, data, deadline, abi.encodePacked(r, s, v));
        vm.stopPrank();

        assertEq(IERC20(USDC).balanceOf(payee), 200e6, "the owner's command ran, carried by someone else");
        assertEq(IERC20(USDC).balanceOf(account), 300e6);
        assertEq(HelicoAccount(payable(account)).nonce(), 1);
    }

    // ------------------------------------------------------------------------------------
    // The Chainlink claim, against the real market
    // ------------------------------------------------------------------------------------

    /// @dev What CRE actually does, done by an address holding exactly CRE's authority against
    ///      the real Aave v3 pool. The mock in the unit suite is faithful to the shape; this is
    ///      the market itself, with its own accounting, its own index, and its own opinions
    ///      about who may withdraw.
    function test_TheAgentPutsRealCapitalToWorkInAaveAndTakesItBack() public onlyForked {
        address account = factory.open(owner);

        vm.startPrank(owner);
        HelicoAccount(payable(account)).setAgent(cre);
        HelicoAccount(payable(account)).permitVenue(AAVE_POOL, true);
        vm.stopPrank();

        vm.prank(USDC_WHALE);
        IERC20(USDC).transfer(account, 10_000e6);

        vm.prank(cre);
        HelicoAccount(payable(account)).supplyIdle(AAVE_POOL, USDC, 8_000e6);

        assertEq(IERC20(USDC).balanceOf(account), 2_000e6, "a buffer stayed liquid");
        // Aave credits the aToken to the supplier, and rounding is against them by a unit or two,
        // so this is a property rather than an equality -- see ForkAaveIdle.t.sol for why.
        uint256 working = IERC20(AUSDC).balanceOf(account);
        assertLe(working, 8_000e6);
        assertGe(working, 8_000e6 - 10);
        assertEq(IERC20(AUSDC).balanceOf(cre), 0, "the position is the account's, not the agent's");

        // And it earns while it waits, which is the entire point.
        vm.warp(block.timestamp + 30 days);
        assertGt(IERC20(AUSDC).balanceOf(account), working, "it grew");

        vm.prank(cre);
        HelicoAccount(payable(account)).withdrawIdle(AAVE_POOL, USDC, 8_000e6);

        assertGe(IERC20(USDC).balanceOf(account), 10_000e6, "it came back to the account");
        assertEq(IERC20(USDC).balanceOf(cre), 0, "and never touched the agent");
    }

    /// @dev The authority is defined by this, not by the test above. An agent that can move
    ///      capital into a market is only safe if that is the whole of what it can do.
    function test_TheAgentCannotTakeRealUsdcOutOfTheAccount() public onlyForked {
        address account = factory.open(owner);

        vm.startPrank(owner);
        HelicoAccount(payable(account)).setAgent(cre);
        HelicoAccount(payable(account)).permitVenue(AAVE_POOL, true);
        vm.stopPrank();

        vm.prank(USDC_WHALE);
        IERC20(USDC).transfer(account, 10_000e6);

        // No general call.
        vm.prank(cre);
        vm.expectRevert(abi.encodeWithSelector(HelicoAccount.NotOwner.selector, cre));
        HelicoAccount(payable(account))
            .execute(USDC, 0, abi.encodeWithSignature("transfer(address,uint256)", cre, 10_000e6));

        // No market of its own choosing, even one that is a real contract.
        vm.prank(cre);
        vm.expectRevert(abi.encodeWithSelector(HelicoAccount.VenueNotPermitted.selector, USDC));
        HelicoAccount(payable(account)).supplyIdle(USDC, USDC, 1_000e6);

        // And no way out through the owner's door.
        address[] memory tokens = new address[](1);
        tokens[0] = USDC;
        vm.prank(cre);
        vm.expectRevert(abi.encodeWithSelector(HelicoAccountProxy.NotOwner.selector, cre));
        HelicoAccountProxy(payable(account)).escape(tokens);

        assertEq(IERC20(USDC).balanceOf(cre), 0);
        assertEq(IERC20(USDC).balanceOf(account), 10_000e6, "untouched");
    }

    function test_TheRelayerCannotRedirectRealUsdcToItself() public onlyForked {
        address account = factory.open(owner);

        vm.prank(USDC_WHALE);
        IERC20(USDC).transfer(account, 500e6);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(HelicoAccount.NotOwner.selector, relayer));
        HelicoAccount(payable(account))
            .execute(USDC, 0, abi.encodeWithSignature("transfer(address,uint256)", relayer, 500e6));

        assertEq(IERC20(USDC).balanceOf(relayer), 0);
    }
}
