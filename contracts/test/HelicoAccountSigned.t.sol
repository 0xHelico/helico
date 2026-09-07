// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {HelicoAccount} from "../src/HelicoAccount.sol";
import {HelicoAccountFactory} from "../src/HelicoAccountFactory.sol";
import {TestToken} from "./MandateTakers.sol";

/// @notice Opens an account and runs the owner's first command in one transaction.
/// @dev What the frontend actually calls. It holds no privilege: `open` is permissionless and the
///      signature is checked by the account against its own immutable owner, so this contract
///      being hostile would change nothing.
contract OneStepRelayer {
    function openAndExecute(
        HelicoAccountFactory factory,
        address owner,
        address target,
        uint256 value,
        bytes calldata data,
        uint256 deadline,
        bytes calldata signature
    ) external returns (address account) {
        account = factory.open(owner);
        HelicoAccount(payable(account)).executeWithSignature(target, value, data, deadline, signature);
    }
}

contract HelicoAccountSignedTest is Test {
    HelicoAccount implementation;
    HelicoAccountFactory factory;
    TestToken token;
    OneStepRelayer relayer;

    address owner;
    uint256 ownerKey;
    address stranger;
    uint256 strangerKey;

    address payee = address(0xBEEF);

    function setUp() public {
        vm.warp(1_000_000);
        (owner, ownerKey) = makeAddrAndKey("owner");
        (stranger, strangerKey) = makeAddrAndKey("stranger");

        implementation = new HelicoAccount(address(0xC2E));
        factory = new HelicoAccountFactory(address(implementation));
        token = new TestToken("Token", "TKN");
        relayer = new OneStepRelayer();
    }

    // ------------------------------------------------------------------------------------
    // The flow this exists for
    // ------------------------------------------------------------------------------------

    /// @dev The whole point: the owner signs once, sends nothing, and both the account's creation
    ///      and their first command land in a single transaction paid for by someone else.
    function test_OneSignatureOpensTheAccountAndRunsTheFirstCommand() public {
        address account = factory.accountFor(owner);
        token.mint(account, 100e18);
        assertFalse(factory.isOpen(owner), "nothing exists yet");

        bytes memory data = abi.encodeWithSignature("transfer(address,uint256)", payee, 40e18);
        // Signed through the factory, because there is no account to ask yet. This is the half of
        // the flow that a digest living only on the account cannot serve.
        bytes32 digest = factory.executeDigest(owner, address(token), 0, data, 0, block.timestamp + 1 hours);
        (uint8 v, bytes32 r, bytes32 sig) = vm.sign(ownerKey, digest);
        bytes memory signature = abi.encodePacked(r, sig, v);

        vm.prank(stranger); // a relayer, not the owner
        relayer.openAndExecute(factory, owner, address(token), 0, data, block.timestamp + 1 hours, signature);

        assertTrue(factory.isOpen(owner), "the account was created on the owner's behalf");
        assertEq(token.balanceOf(payee), 40e18, "and their command ran");
        assertEq(HelicoAccount(payable(account)).nonce(), 1);
    }

    /// @dev The factory answers for an address with no code, and the account must agree once it
    ///      has one. Two derivations of one digest is how a frontend signs something the contract
    ///      will not verify, so this holds them together.
    function test_TheFactoryAndTheAccountAgreeOnTheDigest() public {
        bytes memory data = abi.encodeWithSignature("transfer(address,uint256)", payee, 40e18);
        uint256 deadline = block.timestamp + 1 hours;

        bytes32 before = factory.executeDigest(owner, address(token), 0, data, 0, deadline);
        address account = factory.open(owner);
        bytes32 present = HelicoAccount(payable(account)).executeDigest(address(token), 0, data, 0, deadline);

        assertEq(before, present, "the digest signed before deployment is the one verified after");
    }

    // ------------------------------------------------------------------------------------
    // What a relayer cannot do with what it is carrying
    // ------------------------------------------------------------------------------------

    function test_ASignatureCannotBeUsedTwice() public {
        address account = factory.open(owner);
        token.mint(account, 100e18);

        bytes memory data = abi.encodeWithSignature("transfer(address,uint256)", payee, 40e18);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _sign(account, address(token), 0, data, 0, deadline);

        HelicoAccount(payable(account)).executeWithSignature(address(token), 0, data, deadline, signature);

        // The second attempt recovers a different signer, because the nonce in the digest moved.
        vm.expectRevert();
        HelicoAccount(payable(account)).executeWithSignature(address(token), 0, data, deadline, signature);

        assertEq(token.balanceOf(payee), 40e18, "paid once, not twice");
    }

    function test_ARelayerCannotChangeWhatItCarries() public {
        address account = factory.open(owner);
        token.mint(account, 100e18);

        bytes memory signed = abi.encodeWithSignature("transfer(address,uint256)", payee, 40e18);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _sign(account, address(token), 0, signed, 0, deadline);

        bytes memory tampered = abi.encodeWithSignature("transfer(address,uint256)", stranger, 100e18);
        vm.expectRevert();
        HelicoAccount(payable(account)).executeWithSignature(address(token), 0, tampered, deadline, signature);

        assertEq(token.balanceOf(stranger), 0);
    }

    function test_AStrangersSignatureIsRefused() public {
        address account = factory.open(owner);
        bytes memory data = abi.encodeWithSignature("transfer(address,uint256)", payee, 1);
        uint256 deadline = block.timestamp + 1 hours;

        bytes32 digest = HelicoAccount(payable(account)).executeDigest(address(token), 0, data, 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(strangerKey, digest);

        vm.expectRevert(abi.encodeWithSelector(HelicoAccount.NotOwner.selector, stranger));
        HelicoAccount(payable(account)).executeWithSignature(
            address(token), 0, data, deadline, abi.encodePacked(r, s, v)
        );
    }

    function test_AnExpiredAuthorisationIsRefusedBeforeRecovery() public {
        address account = factory.open(owner);
        bytes memory data = abi.encodeWithSignature("transfer(address,uint256)", payee, 1);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _sign(account, address(token), 0, data, 0, deadline);

        vm.warp(deadline + 1);
        vm.expectRevert(
            abi.encodeWithSelector(HelicoAccount.AuthorisationExpired.selector, block.timestamp, deadline)
        );
        HelicoAccount(payable(account)).executeWithSignature(address(token), 0, data, deadline, signature);
    }

    // ------------------------------------------------------------------------------------
    // The two bindings that stop a signature travelling
    // ------------------------------------------------------------------------------------

    /// @dev One owner can hold accounts under two different factories. A signature made for one
    ///      must not work on the other, and what stops it is `address(this)` in the domain — not
    ///      the owner check, which passes in both.
    function test_ASignatureDoesNotTravelToTheOwnersOtherAccount() public {
        address first = factory.open(owner);

        HelicoAccountFactory second = new HelicoAccountFactory(address(new HelicoAccount(address(0xC2E))));
        address other = second.open(owner);
        assertTrue(first != other, "two accounts, one owner");
        assertEq(HelicoAccount(payable(other)).owner(), owner, "the owner check would pass here");

        token.mint(other, 100e18);
        bytes memory data = abi.encodeWithSignature("transfer(address,uint256)", payee, 40e18);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _sign(first, address(token), 0, data, 0, deadline);

        vm.expectRevert();
        HelicoAccount(payable(other)).executeWithSignature(address(token), 0, data, deadline, signature);
        assertEq(token.balanceOf(payee), 0);
    }

    function test_ASignatureDoesNotTravelToAnotherChain() public {
        address account = factory.open(owner);
        token.mint(account, 100e18);

        bytes memory data = abi.encodeWithSignature("transfer(address,uint256)", payee, 40e18);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _sign(account, address(token), 0, data, 0, deadline);

        vm.chainId(999);
        vm.expectRevert();
        HelicoAccount(payable(account)).executeWithSignature(address(token), 0, data, deadline, signature);
        assertEq(token.balanceOf(payee), 0);
    }

    // ------------------------------------------------------------------------------------
    // Taking it back
    // ------------------------------------------------------------------------------------

    function test_TheOwnerCanTakeBackAnUnusedAuthorisation() public {
        address account = factory.open(owner);
        token.mint(account, 100e18);

        bytes memory data = abi.encodeWithSignature("transfer(address,uint256)", payee, 40e18);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _sign(account, address(token), 0, data, 0, deadline);

        vm.prank(owner);
        HelicoAccount(payable(account)).invalidateSignatures();

        vm.expectRevert();
        HelicoAccount(payable(account)).executeWithSignature(address(token), 0, data, deadline, signature);
        assertEq(token.balanceOf(payee), 0);
    }

    function test_OnlyTheOwnerCanTakeAuthorisationsBack() public {
        address account = factory.open(owner);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(HelicoAccount.NotOwner.selector, stranger));
        HelicoAccount(payable(account)).invalidateSignatures();
    }

    // ------------------------------------------------------------------------------------

    function _sign(address account, address target, uint256 value, bytes memory data, uint256 n, uint256 deadline)
        private
        view
        returns (bytes memory)
    {
        bytes32 digest = HelicoAccount(payable(account)).executeDigest(target, value, data, n, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, digest);
        return abi.encodePacked(r, s, v);
    }
}
