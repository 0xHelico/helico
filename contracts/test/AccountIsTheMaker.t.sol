// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {Aqua} from "@1inch/aqua/Aqua.sol";
import {IAqua} from "@1inch/aqua/interfaces/IAqua.sol";

import {Call} from "../src/AccountAuth.sol";
import {HelicoAccount} from "../src/HelicoAccount.sol";
import {HelicoAccountFactory} from "../src/HelicoAccountFactory.sol";
import {HelicoMandateSwap, SwapMandate, Venue} from "../src/HelicoMandateSwap.sol";
import {MockLendingPool, MockReceipt} from "./MandateVenues.sol";
import {PayingTaker, TestToken} from "./MandateTakers.sol";

/// @notice The two halves of the product, joined: the owner's account **is** the Aqua maker.
///
/// @dev Until this file existed the account tests and the mandate tests never met. Each half
///      passed, and the sentence that matters — *"your capital earns while it waits, and the same
///      capital is what the mandate spends"* — was true of neither on its own.
///
///      It only works because the account is the maker. `_cover` pulls the receipt from
///      `mandate.maker` and has the market pay `mandate.maker`, so the address holding the
///      aTokens and the address whose mandate is being spent have to be the same one. Point the
///      mandate at the owner's EOA instead and `supplyIdle` moves a pot the swap never touches.
contract AccountIsTheMakerTest is Test {
    Aqua aqua;
    HelicoMandateSwap app;
    HelicoAccount implementation;
    HelicoAccountFactory factory;

    TestToken usdc;
    TestToken weth;
    MockLendingPool pool;
    MockReceipt aUsdc;
    PayingTaker taker;

    address owner;
    uint256 ownerKey;
    address agent = address(0xC2E);
    address relayer = address(0xFEE7A);

    address account;

    uint256 constant FUNDED = 50_000e18;
    uint256 constant RESERVE_USDC = 40_000e18;
    uint256 constant RESERVE_WETH = 10e18;
    uint256 constant RECEIPT_BUDGET = 30_000e18;

    function setUp() public {
        vm.warp(1_000_000);
        (owner, ownerKey) = makeAddrAndKey("owner");

        aqua = new Aqua();
        app = new HelicoMandateSwap(IAqua(address(aqua)));
        implementation = new HelicoAccount(address(0));
        factory = new HelicoAccountFactory(address(implementation));

        usdc = new TestToken("USDC", "USDC");
        weth = new TestToken("WETH", "WETH");
        pool = new MockLendingPool();
        aUsdc = pool.list(address(usdc), "aUSDC");

        taker = new PayingTaker(IAqua(address(aqua)));
        weth.mint(address(taker), 100e18);
        taker.approveAqua(address(weth));

        account = factory.open(owner);
        usdc.mint(account, FUNDED);
        vm.prank(owner);
        HelicoAccount(payable(account)).permitVenue(address(pool), true);
        vm.prank(owner);
        HelicoAccount(payable(account)).setAgent(agent);
    }

    /// @dev The whole first-time flow, and the owner signs once.
    function test_OneSignatureSetsUpAMandateTheAccountOwns() public {
        SwapMandate memory m = _mandate();
        Call[] memory calls = _setupCalls(m);
        uint256 deadline = block.timestamp + 1 hours;

        bytes32 digest = HelicoAccount(payable(account)).batchDigest(calls, 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, digest);

        // Carried by a relayer. The owner sent nothing.
        vm.prank(relayer);
        HelicoAccount(payable(account)).executeBatchWithSignature(calls, deadline, abi.encodePacked(r, s, v));

        (uint256 ledgerWeth, uint256 ledgerUsdc) =
            aqua.safeBalances(account, address(app), keccak256(abi.encode(m)), address(weth), address(usdc));
        assertEq(ledgerUsdc, RESERVE_USDC, "the account is the maker, and its ledger is set");
        assertEq(ledgerWeth, RESERVE_WETH);
        assertEq(HelicoAccount(payable(account)).nonce(), 1, "one signature, not four");
    }

    /// @dev The sentence the product is built on, asserted end to end: capital that is earning is
    ///      the same capital the mandate spends, and the swap unwinds only what it needs.
    function test_TheCapitalThatEarnsIsTheCapitalTheMandateSpends() public {
        SwapMandate memory m = _mandate();
        _runSetup(m);

        // The agent puts most of it to work. This is the agent's job, not the owner's, so it is
        // not in the batch — and `ship` writes ledger numbers without checking balances, which is
        // why the receipt could be shipped before the account held a single one.
        vm.prank(agent);
        HelicoAccount(payable(account)).supplyIdle(address(pool), address(usdc), 38_000e18);

        assertEq(usdc.balanceOf(account), 12_000e18, "what stayed liquid");
        assertEq(aUsdc.balanceOf(account), 38_000e18, "what went to work");

        // A swap that needs more USDC than the account kept liquid. `zeroForOne` is false:
        // the taker pays WETH (token1) and the account pays out USDC (token0), which is the side
        // the capital is earning on.
        uint256 out = taker.swap(app, m, false, 5e18, 0, address(taker));

        assertGt(out, 12_000e18, "the swap needed more than the idle balance");
        assertEq(usdc.balanceOf(address(taker)), out, "and the taker was paid in full");
        assertEq(pool.withdrawCalls(), 1, "exactly one unwind, for the shortfall only");
        assertGt(aUsdc.balanceOf(account), 0, "the rest stayed earning");
        assertEq(usdc.balanceOf(agent), 0, "the agent gained nothing");
    }

    /// @dev The reason the account has to be the maker, stated as a test rather than as a comment.
    function test_AMandateNamingTheOwnerInsteadCannotReachWhatTheAgentSupplied() public {
        SwapMandate memory m = _mandate();
        _runSetup(m);
        vm.prank(agent);
        HelicoAccount(payable(account)).supplyIdle(address(pool), address(usdc), 38_000e18);

        // The account holds the receipts. An owner-as-maker mandate would have to find them in
        // the owner's own wallet, and there are none there.
        assertEq(aUsdc.balanceOf(account), 38_000e18);
        assertEq(aUsdc.balanceOf(owner), 0, "supplyIdle moved the account's capital, not the owner's");
    }

    // ------------------------------------------------------------------------------------

    function _mandate() private view returns (SwapMandate memory) {
        Venue[] memory vs = new Venue[](1);
        // `receipt0` is the receipt for token0, and token0 is USDC here.
        vs[0] = Venue({pool: address(pool), receipt0: address(aUsdc), receipt1: address(0)});
        return SwapMandate({
            maker: account,
            token0: address(usdc),
            token1: address(weth),
            feeBps: 30,
            maxOut0: type(uint256).max,
            maxOut1: type(uint256).max,
            expiry: 2_000_000,
            agent: address(taker),
            salt: "joined",
            venues: vs
        });
    }

    /// @dev What an owner actually has to authorise: three approvals and a ship. Four calls that
    ///      are useless separately, so they are one signature.
    function _setupCalls(SwapMandate memory m) private view returns (Call[] memory calls) {
        address[] memory tokens = new address[](3);
        tokens[0] = address(usdc);
        tokens[1] = address(weth);
        tokens[2] = address(aUsdc);
        uint256[] memory amounts = new uint256[](3);
        amounts[0] = RESERVE_USDC;
        amounts[1] = RESERVE_WETH;
        amounts[2] = RECEIPT_BUDGET;

        calls = new Call[](4);
        calls[0] = Call(
            address(usdc),
            0,
            abi.encodeWithSignature("approve(address,uint256)", address(aqua), type(uint256).max)
        );
        calls[1] = Call(
            address(weth),
            0,
            abi.encodeWithSignature("approve(address,uint256)", address(aqua), type(uint256).max)
        );
        calls[2] = Call(
            address(aUsdc),
            0,
            abi.encodeWithSignature("approve(address,uint256)", address(aqua), type(uint256).max)
        );
        calls[3] = Call(
            address(aqua),
            0,
            abi.encodeWithSignature(
                "ship(address,bytes,address[],uint256[])", address(app), abi.encode(m), tokens, amounts
            )
        );
    }

    function _runSetup(SwapMandate memory m) private {
        Call[] memory calls = _setupCalls(m);
        vm.prank(owner);
        HelicoAccount(payable(account)).executeBatch(calls);
    }
}
