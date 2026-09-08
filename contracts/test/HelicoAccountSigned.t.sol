// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {Call} from "../src/AccountAuth.sol";
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
        HelicoAccount(payable(account))
            .executeWithSignature(address(token), 0, data, deadline, abi.encodePacked(r, s, v));
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

    function _sign(
        address account,
        address target,
        uint256 value,
        bytes memory data,
        uint256 n,
        uint256 deadline
    ) private view returns (bytes memory) {
        bytes32 digest = HelicoAccount(payable(account)).executeDigest(target, value, data, n, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, digest);
        return abi.encodePacked(r, s, v);
    }
}

/// @notice The batch, and what a relayer cannot do with one.
contract HelicoAccountBatchTest is Test {
    HelicoAccount implementation;
    HelicoAccountFactory factory;
    TestToken token;

    address owner;
    uint256 ownerKey;
    address stranger;
    uint256 strangerKey;
    address payee = address(0xBEEF);
    address account;

    function setUp() public {
        vm.warp(1_000_000);
        (owner, ownerKey) = makeAddrAndKey("batch-owner");
        (stranger, strangerKey) = makeAddrAndKey("batch-stranger");
        implementation = new HelicoAccount(address(0));
        factory = new HelicoAccountFactory(address(implementation));
        token = new TestToken("Token", "TKN");
        account = factory.open(owner);
        token.mint(account, 100e18);
    }

    function _pair() private view returns (Call[] memory calls) {
        calls = new Call[](2);
        calls[0] = Call(address(token), 0, abi.encodeWithSignature("transfer(address,uint256)", payee, 10e18));
        calls[1] = Call(address(token), 0, abi.encodeWithSignature("approve(address,uint256)", payee, 5e18));
    }

    function _sign(Call[] memory calls, uint256 n, uint256 deadline) private view returns (bytes memory) {
        bytes32 digest = HelicoAccount(payable(account)).batchDigest(calls, n, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_OneSignatureCarriesEveryCall() public {
        Call[] memory calls = _pair();
        uint256 deadline = block.timestamp + 1 hours;

        vm.prank(stranger); // a relayer
        HelicoAccount(payable(account)).executeBatchWithSignature(calls, deadline, _sign(calls, 0, deadline));

        assertEq(token.balanceOf(payee), 10e18, "the first call ran");
        assertEq(token.allowance(account, payee), 5e18, "and so did the second");
        assertEq(HelicoAccount(payable(account)).nonce(), 1, "one signature spent, not two");
    }

    /// @dev A half-landed batch is the failure this exists to prevent: a mandate shipped without
    ///      the approvals it needs looks funded and fails at the first swap.
    function test_ABatchIsAllOrNothing() public {
        Call[] memory calls = new Call[](2);
        calls[0] = Call(address(token), 0, abi.encodeWithSignature("transfer(address,uint256)", payee, 10e18));
        calls[1] =
            Call(address(token), 0, abi.encodeWithSignature("transfer(address,uint256)", payee, 1_000e18));

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(HelicoAccount.CallFailed.selector, address(token)));
        HelicoAccount(payable(account)).executeBatch(calls);

        assertEq(token.balanceOf(payee), 0, "the call that could have landed did not");
    }

    function test_ABatchSignatureCannotBeUsedTwice() public {
        Call[] memory calls = _pair();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(calls, 0, deadline);

        HelicoAccount(payable(account)).executeBatchWithSignature(calls, deadline, sig);
        vm.expectRevert();
        HelicoAccount(payable(account)).executeBatchWithSignature(calls, deadline, sig);

        assertEq(token.balanceOf(payee), 10e18, "paid once");
    }

    /// @dev The digest commits to every call, so a relayer cannot append, drop or edit one.
    function test_ARelayerCannotChangeTheBatch() public {
        Call[] memory signed = _pair();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(signed, 0, deadline);

        Call[] memory tampered = new Call[](3);
        tampered[0] = signed[0];
        tampered[1] = signed[1];
        tampered[2] =
            Call(address(token), 0, abi.encodeWithSignature("transfer(address,uint256)", stranger, 90e18));

        vm.expectRevert();
        HelicoAccount(payable(account)).executeBatchWithSignature(tampered, deadline, sig);
        assertEq(token.balanceOf(stranger), 0);
    }

    function test_AStrangerCannotBatch() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(HelicoAccount.NotOwner.selector, stranger));
        HelicoAccount(payable(account)).executeBatch(_pair());
    }

    function test_ABatchIsNotPayableSoValueCannotBeCountedTwice() public {
        // `executeBatch` has no `payable`, so the compiler refuses value at the call site. The
        // value each call carries comes from the account's own balance, which cannot be reused.
        vm.deal(account, 3 ether);
        Call[] memory calls = new Call[](2);
        calls[0] = Call(payee, 1 ether, "");
        calls[1] = Call(payee, 1 ether, "");

        vm.prank(owner);
        HelicoAccount(payable(account)).executeBatch(calls);

        assertEq(payee.balance, 2 ether, "two ether left the account for two calls of one");
        assertEq(account.balance, 1 ether);
    }
}
