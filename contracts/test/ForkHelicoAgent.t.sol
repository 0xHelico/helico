// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {HelicoAccount} from "../src/HelicoAccount.sol";
import {HelicoAgent} from "../src/HelicoAgent.sol";
import {HelicoAppProxy} from "../src/HelicoAppProxy.sol";
import {MorphoVenue} from "../src/MorphoVenue.sol";

/// @notice The move the enclave has been deciding every five minutes, made — on a fork of the chain
///         it decided about, through the account it decided about, from the address the real
///         forwarder has.
///
/// @dev Everything below except two pranks is the production path. The account is the live one
///      (owner rifky, opened 10 September), the venue is the deployed `MorphoVenue` the
///      owner already permitted, the forwarder is `KeystoneForwarder 1.0.0` at the address the
///      CRE forwarder directory gives for Arbitrum One, and the report bytes are the shape
///      `encodeReport` produces. The two pranks are the owner nominating the agent — which on the
///      chain is a transaction only the owner can send — and the forwarder's `route`, which only a
///      DON transmitter can reach, so the receiver is called from the forwarder's address directly.
///
///      **The account is topped up on the fork, and every assertion is a delta.** The first
///      version read the live balance and moved "all but the floor" of it, which was true for
///      exactly as long as the DON had not yet done that on the real chain — the 11:30 UTC move
///      left the account holding the floor and nothing else, and the test failed with
///      `NothingToSupply` against the very state it had helped bring about. So the fork now
///      receives half a dollar from a real holder, the move is sized from that, and what is
///      checked is the change on each side, with the venue's `previewRedeem` of the shares
///      gained standing in for the money — a share count is not an amount (#323).
contract ForkHelicoAgentTest is Test {
    /// @dev `KeystoneForwarder 1.0.0` — `typeAndVersion()` on chain answers exactly that.
    address constant FORWARDER = 0xF8344CFd5c43616a4366C34E3EEE75af79a74482;
    /// @dev The CRE key that deploys Helico's workflows. Also the deployer.
    address constant WORKFLOW_OWNER = 0x6DCd7485aB17e0CBD0723b8435a35bb8d029439E;
    address constant UPGRADER = 0xaeE1F9d2c23730CA04Dd478830c2acc495536E9C;

    HelicoAccount constant ACCOUNT = HelicoAccount(payable(0x0AcdFa21a3cD075aee6583c8A8069F86ad3e4a39));
    MorphoVenue constant MORPHO = MorphoVenue(0xBBa798A61f0D7D1AE51466Fd4045Cd2Ea25c9A29);
    IERC20 constant USDC = IERC20(0xaf88d065e77c8cC2239327C5EDb3A432268e5831);

    /// @dev `SECRET_IDLE_MIN_IDLE_AMOUNT` in production: 0.01 USDC.
    uint256 constant FLOOR = 10_000;
    /// @dev What the fork adds to whatever the account already holds. From the aUSDC contract,
    ///      which holds real USDC, rather than written into a storage slot: the transfer has to
    ///      pass through the token.
    uint256 constant TOP_UP = 500_000;
    address constant USDC_HOLDER = 0x724dc807b04555b71ed48a6896b6F41593b8C637;

    bytes32 constant POLICY = 0xa48db44df37fd9f13ef34f8d390ffa6915b577c9e4dce80921c43f7a8b921af1;
    bytes32 constant WORKFLOW_ID = keccak256("helico-production");

    HelicoAgent agent;
    bool forked;

    event IdleCapitalMoved(address indexed pool, address indexed asset, uint256 amount, bool supplied);

    function setUp() public {
        try vm.createSelectFork("arbitrum") {
            forked = block.chainid == 42161;
        } catch {
            forked = false;
        }
        if (!forked) {
            emit log("no endpoint: set ARBITRUM_RPC_URL to run this fork suite");
            vm.skip(true);
        }

        HelicoAgent implementation = new HelicoAgent(FORWARDER, WORKFLOW_OWNER, UPGRADER);
        agent = HelicoAgent(address(new HelicoAppProxy(address(implementation))));

        // The owner naming this fork's copy of the contract as the agent — on the chain the owner
        // named the deployed one, which this test's fresh deployment is not.
        vm.prank(ACCOUNT.owner());
        ACCOUNT.setAgent(address(agent));

        vm.prank(USDC_HOLDER);
        USDC.transfer(address(ACCOUNT), TOP_UP);
    }

    /// @dev The move the 100% target asks for: everything above the floor.
    function movable() internal view returns (uint256) {
        return USDC.balanceOf(address(ACCOUNT)) - FLOOR;
    }

    function metadata() internal pure returns (bytes memory) {
        return abi.encodePacked(WORKFLOW_ID, bytes10("a1b2c3d4e5"), WORKFLOW_OWNER, bytes2(0));
    }

    function report(uint256 amount, bool supply) internal view returns (bytes memory) {
        HelicoAgent.IdleMove memory move = HelicoAgent.IdleMove({
            account: address(ACCOUNT),
            pool: address(MORPHO),
            asset: address(USDC),
            amount: amount,
            supply: supply,
            deadline: block.timestamp + 600
        });
        return abi.encode(true, POLICY, move);
    }

    function test_ThePreconditionsTheChainAlreadyHas() public view {
        assertEq(ACCOUNT.agent(), address(agent), "nominated in setUp");
        assertTrue(ACCOUNT.permittedVenue(address(MORPHO)), "the owner permitted Morpho on 10 September");
        assertGe(USDC.balanceOf(address(ACCOUNT)), TOP_UP, "the top-up landed");
        assertGt(FORWARDER.code.length, 0, "the forwarder is a contract");
    }

    /// @dev The anchor. USDC leaves the account, the receipt appears, and the receipt is worth what
    ///      left — not a share count that happens to be near it.
    function test_TheDonsReportMovesTheIdleCapitalIntoMorpho() public {
        uint256 amount = movable();
        uint256 sharesBefore = MORPHO.balanceOf(address(ACCOUNT));

        vm.prank(FORWARDER);
        vm.expectEmit(true, true, false, true, address(ACCOUNT));
        emit IdleCapitalMoved(address(MORPHO), address(USDC), amount, true);
        agent.onReport(metadata(), report(amount, true));

        assertEq(USDC.balanceOf(address(ACCOUNT)), FLOOR, "the floor stays liquid, the rest went");
        uint256 gained = MORPHO.balanceOf(address(ACCOUNT)) - sharesBefore;
        assertGt(gained, 0, "the account holds more of the venue's receipt");
        uint256 worth = MORPHO.previewRedeem(gained);
        assertLe(worth, amount, "rounding never favours the supplier");
        assertGe(worth, amount - 2, "and costs at most dust");
        assertEq(USDC.balanceOf(address(agent)), 0, "the agent contract holds nothing");
        assertEq(MORPHO.balanceOf(address(agent)), 0, "not even a receipt");
    }

    /// @dev And back, through the same door: a withdraw report is the agent correcting itself.
    function test_AWithdrawReportBringsItBack() public {
        uint256 idle = USDC.balanceOf(address(ACCOUNT));
        uint256 amount = movable();
        uint256 sharesBefore = MORPHO.balanceOf(address(ACCOUNT));
        vm.prank(FORWARDER);
        agent.onReport(metadata(), report(amount, true));

        uint256 back = MORPHO.previewRedeem(MORPHO.balanceOf(address(ACCOUNT)) - sharesBefore);
        vm.prank(FORWARDER);
        agent.onReport(metadata(), report(back, false));

        assertGe(USDC.balanceOf(address(ACCOUNT)), idle - 2, "all but dust is idle again");
        assertLe(
            MORPHO.balanceOf(address(ACCOUNT)),
            sharesBefore + 2,
            "and the venue holds what it held before, plus dust at most"
        );
    }

    /// @dev Same bytes, wrong sender: the real account, the real venue, and nothing moves.
    function test_TheSameReportFromAnyoneElseMovesNothing() public {
        uint256 idle = USDC.balanceOf(address(ACCOUNT));
        // Sized before `expectRevert`: it arms the next external call, and `movable()` makes one.
        bytes memory r = report(movable(), true);
        vm.expectRevert(abi.encodeWithSelector(HelicoAgent.NotTheForwarder.selector, address(this)));
        agent.onReport(metadata(), r);
        assertEq(USDC.balanceOf(address(ACCOUNT)), idle);
    }

    /// @dev The account's own rule, seen from the forwarder's side: a venue the owner never
    ///      permitted reverts in the account, and the revert reaches the forwarder.
    function test_AVenueTheOwnerNeverPermittedIsRefusedByTheAccount() public {
        address stranger = address(0x5717A);
        HelicoAgent.IdleMove memory move = HelicoAgent.IdleMove({
            account: address(ACCOUNT),
            pool: stranger,
            asset: address(USDC),
            amount: 1,
            supply: true,
            deadline: 0
        });
        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(HelicoAccount.VenueNotPermitted.selector, stranger));
        agent.onReport(metadata(), abi.encode(true, POLICY, move));
    }

    /// @dev What the owner keeps: revoke the nomination and the same report is a stranger's.
    function test_TheOwnerCanRevokeTheAgentAndTheReportStops() public {
        vm.prank(ACCOUNT.owner());
        ACCOUNT.setAgent(address(0));

        uint256 idle = USDC.balanceOf(address(ACCOUNT));
        bytes memory r = report(movable(), true);
        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(HelicoAccount.NotOwnerOrAgent.selector, address(agent)));
        agent.onReport(metadata(), r);
        assertEq(USDC.balanceOf(address(ACCOUNT)), idle);
    }
}
