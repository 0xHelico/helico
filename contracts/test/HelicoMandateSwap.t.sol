// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {Aqua} from "@1inch/aqua/Aqua.sol";
import {AquaApp} from "@1inch/aqua/AquaApp.sol";
import {IAqua} from "@1inch/aqua/interfaces/IAqua.sol";

import {HelicoMandateSwap, SwapMandate, Venue} from "../src/HelicoMandateSwap.sol";
import {
    FeeOnTransferToken,
    FreeloadingTaker,
    PayingTaker,
    SameMandateReentrantTaker,
    SiblingMandateTaker,
    TestToken
} from "./MandateTakers.sol";

/// @notice The mandate rules, exercised against a real Aqua.
///
/// @dev Aqua is deployed here rather than forked: it holds no tokens, keys everything by the
///      caller, and needs no other protocol to work, so a local deployment is the real thing
///      and not a stand-in. Nothing in this file mocks Aqua or the app.
contract HelicoMandateSwapTest is Test {
    Aqua aqua;
    HelicoMandateSwap app;
    TestToken tokenA;
    TestToken tokenB;

    PayingTaker agentTaker;
    PayingTaker strangerTaker;

    address maker = address(0xA11CE);

    uint256 constant RESERVE_A = 1000e18;
    uint256 constant RESERVE_B = 1000e18;
    uint256 constant FEE_BPS = 30;
    uint256 constant AMOUNT_IN = 100e18;
    uint64 constant EXPIRY = 2_000_000;
    uint256 constant NO_CEILING = type(uint256).max;

    function setUp() public {
        vm.warp(1_000_000);

        aqua = new Aqua();
        app = new HelicoMandateSwap(IAqua(address(aqua)), address(0));

        tokenA = new TestToken("Token A", "TKA");
        tokenB = new TestToken("Token B", "TKB");

        // The maker holds far more than any one mandate commits, because Aqua's ledger is an
        // allowance and not a deposit: several mandates may name the same wallet.
        tokenA.mint(maker, 1_000_000e18);
        tokenB.mint(maker, 1_000_000e18);
        vm.startPrank(maker);
        tokenA.approve(address(aqua), type(uint256).max);
        tokenB.approve(address(aqua), type(uint256).max);
        vm.stopPrank();

        agentTaker = new PayingTaker(IAqua(address(aqua)));
        strangerTaker = new PayingTaker(IAqua(address(aqua)));
        _fund(address(agentTaker));
        _fund(address(strangerTaker));
    }

    // --------------------------------------------------------------------------------------
    // Positive
    // --------------------------------------------------------------------------------------

    function test_ASwapAtExactlyTheCeilingIsAllowed() public {
        uint256 out = _quoteOffChain(RESERVE_A, RESERVE_B, AMOUNT_IN);
        SwapMandate memory m = _mandate(address(agentTaker), NO_CEILING, out, "at-ceiling");
        _ship(m);

        uint256 got = agentTaker.swap(app, m, true, AMOUNT_IN, 0, address(agentTaker));

        assertEq(got, out, "the swap must land exactly on the ceiling, not near it");
        assertGt(got, 0, "a zero output would satisfy any ceiling and prove nothing");
        (uint256 balA,) = aqua.rawBalances(maker, address(app), _hash(m), address(tokenA));
        (uint256 balB,) = aqua.rawBalances(maker, address(app), _hash(m), address(tokenB));
        assertEq(balA, RESERVE_A + AMOUNT_IN, "the input side must be credited in full");
        assertEq(balB, RESERVE_B - out, "the output side must be debited by what left");
    }

    function test_TheCeilingBindsWhicheverTokenIsLeaving() public {
        uint256 out = _quoteOffChain(RESERVE_A, RESERVE_B, AMOUNT_IN);

        SwapMandate memory forward = _mandate(address(agentTaker), NO_CEILING, out, "fwd");
        _ship(forward);
        uint256 gotForward = agentTaker.swap(app, forward, true, AMOUNT_IN, 0, address(agentTaker));

        // The mirrored mandate puts the ceiling on token0, and the swap runs the other way.
        SwapMandate memory backward = _mandate(address(agentTaker), out, NO_CEILING, "bwd");
        _ship(backward);
        uint256 gotBackward = agentTaker.swap(app, backward, false, AMOUNT_IN, 0, address(agentTaker));

        assertEq(gotForward, out, "forward must reach its ceiling");
        assertEq(gotBackward, out, "backward must reach its ceiling");
        assertGt(gotBackward, 0, "both directions must actually move tokens");
    }

    function test_ASwapOneSecondBeforeExpiryIsAllowed() public {
        SwapMandate memory m = _mandate(address(agentTaker), NO_CEILING, NO_CEILING, "eve");
        _ship(m);

        vm.warp(EXPIRY - 1);
        uint256 got = agentTaker.swap(app, m, true, AMOUNT_IN, 0, address(agentTaker));

        assertGt(got, 0, "the last legal second must still trade");
    }

    function test_AnOpenMandateLetsAnyoneTake() public {
        SwapMandate memory m = _mandate(address(0), NO_CEILING, NO_CEILING, "open");
        _ship(m);

        // strangerTaker is named nowhere in the mandate.
        uint256 got = strangerTaker.swap(app, m, true, AMOUNT_IN, 0, address(strangerTaker));

        assertGt(got, 0, "an unnamed agent must mean open, not closed");
    }

    function test_TheNamedAgentCanTakeAndTheRecipientNeedNotBeIt() public {
        address beneficiary = address(0xB0B);
        SwapMandate memory m = _mandate(address(agentTaker), NO_CEILING, NO_CEILING, "named");
        _ship(m);

        uint256 agentBefore = tokenB.balanceOf(address(agentTaker));
        uint256 got = agentTaker.swap(app, m, true, AMOUNT_IN, 0, beneficiary);

        assertGt(got, 0, "the named agent must be able to trade");
        assertEq(tokenB.balanceOf(beneficiary), got, "output must reach the named recipient");
        assertEq(
            tokenB.balanceOf(address(agentTaker)),
            agentBefore,
            "the agent pays and executes but receives nothing"
        );
    }

    function test_TheQuoteEqualsWhatTheSwapReturns() public {
        SwapMandate memory m = _mandate(address(agentTaker), NO_CEILING, NO_CEILING, "quote");
        _ship(m);

        uint256 quoted = app.quoteExactIn(m, true, AMOUNT_IN);
        uint256 got = agentTaker.swap(app, m, true, AMOUNT_IN, 0, address(agentTaker));

        assertEq(quoted, got, "a quote that disagrees with the swap sends an agent to fail");
    }

    /// @dev A mandate bound to an agent must still be priceable by anyone. The gate is about
    ///      who may move the maker's tokens, not about who may read a number, and a quote that
    ///      refused strangers would break every router and indexer without protecting anything.
    function test_AnyoneCanQuoteAMandateBoundToAnAgent() public {
        SwapMandate memory m = _mandate(address(agentTaker), NO_CEILING, NO_CEILING, "quote-gate");
        _ship(m);

        // This test contract is not the agent, and is not funded or approved for anything.
        uint256 quoted = app.quoteExactIn(m, true, AMOUNT_IN);

        assertEq(quoted, _quoteOffChain(RESERVE_A, RESERVE_B, AMOUNT_IN), "quoting must be open");

        vm.expectRevert(
            abi.encodeWithSelector(
                HelicoMandateSwap.UnauthorizedAgent.selector, address(strangerTaker), address(agentTaker)
            )
        );
        strangerTaker.swap(app, m, true, AMOUNT_IN, 0, address(strangerTaker));
    }

    function test_TheCurveIsConstantProductAfterFee() public {
        SwapMandate memory m = _mandate(address(agentTaker), NO_CEILING, NO_CEILING, "curve");
        _ship(m);

        // Pinned by hand, not by the helper: 100e18 * 9970 / 10000 = 99.7e18 in after fee, and
        // 99.7e18 * 1000e18 / 1099.7e18 truncates to the figure below. Computed separately in
        // integer arithmetic rather than copied from a passing run, which would assert only
        // that the contract agrees with itself. If the formula drifts, the helper drifts with
        // it, so one literal has to hold the line.
        uint256 quoted = app.quoteExactIn(m, true, AMOUNT_IN);
        assertEq(quoted, 90_661_089_388_014_913_158, "the curve must not move under anyone");

        // And the invariant the curve exists to keep: the product may only grow, by the fee.
        uint256 withFee = AMOUNT_IN * (10_000 - FEE_BPS) / 10_000;
        assertGe(
            (RESERVE_A + withFee) * (RESERVE_B - quoted),
            RESERVE_A * RESERVE_B,
            "a swap must never shrink the product the maker is left holding"
        );
    }

    function test_TheLiquidityNeverLeavesTheMakersWallet() public {
        SwapMandate memory m = _mandate(address(agentTaker), NO_CEILING, NO_CEILING, "custody");
        _ship(m);

        assertEq(tokenA.balanceOf(address(aqua)), 0, "Aqua must hold nothing after ship");
        assertEq(tokenA.balanceOf(address(app)), 0, "the app must hold nothing after ship");

        uint256 makerBefore = tokenB.balanceOf(maker);
        uint256 got = agentTaker.swap(app, m, true, AMOUNT_IN, 0, address(agentTaker));

        assertEq(tokenA.balanceOf(address(aqua)), 0, "Aqua must hold nothing after a swap");
        assertEq(tokenA.balanceOf(address(app)), 0, "the app must hold nothing after a swap");
        assertEq(tokenB.balanceOf(maker), makerBefore - got, "output leaves the maker directly");
        assertEq(tokenA.balanceOf(maker), 1_000_000e18 + AMOUNT_IN, "input arrives directly");
    }

    // --------------------------------------------------------------------------------------
    // Negative
    // --------------------------------------------------------------------------------------

    function test_ASwapOneWeiOverTheCeilingIsRefused() public {
        uint256 out = _quoteOffChain(RESERVE_A, RESERVE_B, AMOUNT_IN);
        SwapMandate memory m = _mandate(address(agentTaker), NO_CEILING, out - 1, "over");
        _ship(m);

        vm.expectRevert(
            abi.encodeWithSelector(
                HelicoMandateSwap.MandateCeilingExceeded.selector, address(tokenB), out, out - 1
            )
        );
        agentTaker.swap(app, m, true, AMOUNT_IN, 0, address(agentTaker));
    }

    function test_TheCeilingIsRefusedInTheOtherDirectionToo() public {
        uint256 out = _quoteOffChain(RESERVE_B, RESERVE_A, AMOUNT_IN);
        SwapMandate memory m = _mandate(address(agentTaker), out - 1, NO_CEILING, "over-bwd");
        _ship(m);

        vm.expectRevert(
            abi.encodeWithSelector(
                HelicoMandateSwap.MandateCeilingExceeded.selector, address(tokenA), out, out - 1
            )
        );
        agentTaker.swap(app, m, false, AMOUNT_IN, 0, address(agentTaker));
    }

    function test_AnOutputBelowTheCallersMinimumIsRefused() public {
        SwapMandate memory m = _mandate(address(agentTaker), NO_CEILING, NO_CEILING, "slippage");
        _ship(m);

        uint256 out = _quoteOffChain(RESERVE_A, RESERVE_B, AMOUNT_IN);

        vm.expectRevert(
            abi.encodeWithSelector(HelicoMandateSwap.InsufficientOutputAmount.selector, out, out + 1)
        );
        agentTaker.swap(app, m, true, AMOUNT_IN, out + 1, address(agentTaker));

        // And the boundary holds from the other side: asking for exactly what the curve pays is
        // accepted, so the refusal above is the bound and not an off-by-one in it.
        uint256 got = agentTaker.swap(app, m, true, AMOUNT_IN, out, address(agentTaker));
        assertEq(got, out, "a minimum equal to the output must be accepted");
    }

    function test_ASwapAtExactlyTheExpiryTimestampIsRefused() public {
        SwapMandate memory m = _mandate(address(agentTaker), NO_CEILING, NO_CEILING, "expired");
        _ship(m);

        vm.warp(EXPIRY);
        vm.expectRevert(abi.encodeWithSelector(HelicoMandateSwap.MandateExpired.selector, EXPIRY, EXPIRY));
        agentTaker.swap(app, m, true, AMOUNT_IN, 0, address(agentTaker));
    }

    function test_AStrangerCannotTakeAMandateBoundToAnAgent() public {
        SwapMandate memory m = _mandate(address(agentTaker), NO_CEILING, NO_CEILING, "bound");
        _ship(m);

        vm.expectRevert(
            abi.encodeWithSelector(
                HelicoMandateSwap.UnauthorizedAgent.selector, address(strangerTaker), address(agentTaker)
            )
        );
        strangerTaker.swap(app, m, true, AMOUNT_IN, 0, address(strangerTaker));
    }

    /// @dev The control for the test above. Without it, the refusal proves nothing: solc emits
    ///      an EXTCODESIZE check before the callback, so a taker that is merely unable would
    ///      revert anyway. This shows the *same* contract succeeds once the mandate names it.
    function test_TheSameStrangerSucceedsWhenTheMandateNamesIt() public {
        SwapMandate memory m = _mandate(address(strangerTaker), NO_CEILING, NO_CEILING, "names-it");
        _ship(m);

        uint256 got = strangerTaker.swap(app, m, true, AMOUNT_IN, 0, address(strangerTaker));

        assertGt(got, 0, "the refusal above must be the gate, not the taker's own inability");
    }

    function test_ADockedMandateCannotBeSwapped() public {
        SwapMandate memory m = _mandate(address(agentTaker), NO_CEILING, NO_CEILING, "docked");
        bytes32 hash = _ship(m);

        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenA);
        tokens[1] = address(tokenB);
        vm.prank(maker);
        aqua.dock(address(app), hash, tokens);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAqua.SafeBalancesForTokenNotInActiveStrategy.selector,
                maker,
                address(app),
                hash,
                address(tokenA)
            )
        );
        agentTaker.swap(app, m, true, AMOUNT_IN, 0, address(agentTaker));
    }

    function test_TheSameMandateCannotBeReenteredInsideItsCallback() public {
        SameMandateReentrantTaker attacker = new SameMandateReentrantTaker(IAqua(address(aqua)));
        _fund(address(attacker));

        SwapMandate memory m = _mandate(address(attacker), NO_CEILING, NO_CEILING, "reenter");
        _ship(m);
        attacker.arm(app, m);

        // TransientLockLib.UnexpectedLock(), reached through the app's own call frame.
        vm.expectRevert(abi.encodeWithSignature("UnexpectedLock()"));
        attacker.swap(app, m, true, AMOUNT_IN, 0, address(attacker));
    }

    function test_ATakerThatDoesNotPayIsRefused() public {
        FreeloadingTaker freeloader = new FreeloadingTaker(IAqua(address(aqua)));
        _fund(address(freeloader));

        SwapMandate memory m = _mandate(address(freeloader), NO_CEILING, NO_CEILING, "freeload");
        _ship(m);

        vm.expectRevert(
            abi.encodeWithSelector(
                AquaApp.MissingTakerAquaPush.selector, address(tokenA), RESERVE_A, RESERVE_A + AMOUNT_IN
            )
        );
        freeloader.swap(app, m, true, AMOUNT_IN, 0, address(freeloader));
    }

    function test_AnExpiredMandateDoesNotProduceAQuote() public {
        SwapMandate memory m = _mandate(address(0), NO_CEILING, NO_CEILING, "no-quote");
        _ship(m);

        vm.warp(EXPIRY);
        vm.expectRevert(abi.encodeWithSelector(HelicoMandateSwap.MandateExpired.selector, EXPIRY, EXPIRY));
        app.quoteExactIn(m, true, AMOUNT_IN);
    }

    /// @dev One test, not one per field. Aqua files a mandate under the hash of the bytes the
    ///      maker shipped, so changing any field at all produces a hash Aqua has never seen.
    ///      Writing seven tests here would restate one protocol fact seven times.
    function test_AnyTamperedFieldLandsOnAMandateAquaHasNeverSeen() public {
        SwapMandate memory original = _mandate(address(0), 1e18, 1e18, "tamper");
        _ship(original);

        for (uint256 i = 0; i < 6; i++) {
            SwapMandate memory forged = _mandate(address(0), 1e18, 1e18, "tamper");
            if (i == 0) forged.maxOut0 = type(uint256).max;
            if (i == 1) forged.maxOut1 = type(uint256).max;
            if (i == 2) forged.feeBps = 0;
            if (i == 3) forged.expiry = EXPIRY + 1 days;
            if (i == 4) forged.salt = "other";
            if (i == 5) forged.maker = address(0xDEAD);

            vm.expectRevert(
                abi.encodeWithSelector(
                    IAqua.SafeBalancesForTokenNotInActiveStrategy.selector,
                    forged.maker,
                    address(app),
                    _hash(forged),
                    address(tokenA)
                )
            );
            strangerTaker.swap(app, forged, true, AMOUNT_IN, 0, address(strangerTaker));
        }
    }

    // --------------------------------------------------------------------------------------
    // Edge
    // --------------------------------------------------------------------------------------

    /// @dev The one that matters most. Aqua validates nothing at ship time and happily accepts a
    ///      zero amount, leaving the mandate active. Constant product then reads
    ///      `amountOut = amountIn * balanceOut / (0 + amountIn) == balanceOut`: two wei of input
    ///      takes the entire opposite reserve, and no output ceiling in the world is small
    ///      enough to notice, because the ceiling is compared against a number that is only
    ///      wrong because the reserve is empty.
    function test_AMandateShippedWithAnEmptySideIsRefused() public {
        SwapMandate memory m = _mandate(address(agentTaker), NO_CEILING, NO_CEILING, "empty");

        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenA);
        tokens[1] = address(tokenB);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 0;
        amounts[1] = RESERVE_B;
        vm.prank(maker);
        aqua.ship(address(app), abi.encode(m), tokens, amounts);

        vm.expectRevert(abi.encodeWithSelector(HelicoMandateSwap.DegenerateReserves.selector, 0, RESERVE_B));
        agentTaker.swap(app, m, true, 2, 0, address(agentTaker));
    }

    function test_AFeeAtOrAboveOneHundredPercentIsRefused() public {
        SwapMandate memory m = _mandate(address(agentTaker), NO_CEILING, NO_CEILING, "fee");
        m.feeBps = 10_000;
        _ship(m);

        vm.expectRevert(abi.encodeWithSelector(HelicoMandateSwap.InvalidFee.selector, 10_000));
        agentTaker.swap(app, m, true, AMOUNT_IN, 0, address(agentTaker));
    }

    /// @dev Documents a limit rather than catching a bug, and is here for that reason. The lock
    ///      is released when each call returns, so a loop multiplies the ceiling freely. If the
    ///      README ever calls this a spending budget, this test is the evidence that it is not.
    function test_TheCeilingIsPerSwapNotPerTransaction() public {
        uint256 out = _quoteOffChain(RESERVE_A, RESERVE_B, AMOUNT_IN);
        SwapMandate memory m = _mandate(address(agentTaker), NO_CEILING, out, "per-swap");
        _ship(m);

        uint256 total = agentTaker.swapMany(app, m, true, AMOUNT_IN, 3);

        assertGt(total, out, "three swaps in one transaction move more than one ceiling");
        (uint256 balA,) = aqua.rawBalances(maker, address(app), _hash(m), address(tokenA));
        assertEq(balA, RESERVE_A + 3 * AMOUNT_IN, "all three inputs must have been paid");
    }

    /// @dev Also a limit, and the reason not to add a per-maker counter later: the lock is keyed
    ///      by `(maker, mandateHash)`, so a second mandate of the same maker is reachable from
    ///      inside the first one's callback.
    function test_ASiblingMandateOfTheSameMakerMayBeSwappedInsideACallback() public {
        SiblingMandateTaker taker = new SiblingMandateTaker(IAqua(address(aqua)));
        _fund(address(taker));

        SwapMandate memory first = _mandate(address(taker), NO_CEILING, NO_CEILING, "sib-1");
        SwapMandate memory second = _mandate(address(taker), NO_CEILING, NO_CEILING, "sib-2");
        _ship(first);
        _ship(second);
        taker.arm(app, second, AMOUNT_IN);

        uint256 got = taker.swap(app, first, true, AMOUNT_IN, 0, address(taker));

        assertGt(got, 0, "the outer swap must complete");
        (uint256 firstIn,) = aqua.rawBalances(maker, address(app), _hash(first), address(tokenA));
        (uint256 secondIn,) = aqua.rawBalances(maker, address(app), _hash(second), address(tokenA));
        assertEq(firstIn, RESERVE_A + AMOUNT_IN, "the two ledgers must move independently");
        assertEq(secondIn, RESERVE_A + AMOUNT_IN, "the sibling must have been paid separately");
    }

    /// @dev Zero reads as "no expiry" to almost everyone. Here it means permanently dead, and
    ///      because a mandate is immutable and its hash is burned by docking, the mistake cannot
    ///      be repaired in place -- only re-issued under a new salt.
    function test_AnExpiryOfZeroIsPermanentlyDead() public {
        SwapMandate memory m = _mandate(address(agentTaker), NO_CEILING, NO_CEILING, "zero-exp");
        m.expiry = 0;
        _ship(m);

        vm.expectRevert(abi.encodeWithSelector(HelicoMandateSwap.MandateExpired.selector, block.timestamp, 0));
        agentTaker.swap(app, m, true, AMOUNT_IN, 0, address(agentTaker));
    }

    function test_APairNamingTheSameTokenTwiceIsRefused() public {
        SwapMandate memory m = _mandate(address(agentTaker), NO_CEILING, NO_CEILING, "same-token");
        m.token1 = address(tokenA);

        address[] memory tokens = new address[](1);
        tokens[0] = address(tokenA);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = RESERVE_A;
        vm.prank(maker);
        aqua.ship(address(app), abi.encode(m), tokens, amounts);

        vm.expectRevert(abi.encodeWithSelector(HelicoMandateSwap.IdenticalTokens.selector, address(tokenA)));
        agentTaker.swap(app, m, true, AMOUNT_IN, 0, address(agentTaker));
    }

    /// @dev Not a fix, a measurement. Aqua credits the nominal amount on push, so a token that
    ///      keeps a cut leaves the ledger claiming more than the maker received. The app cannot
    ///      detect this from inside a swap; the README says so, and this is why.
    function test_AFeeOnTransferTokenDesyncsTheLedger() public {
        FeeOnTransferToken fot = new FeeOnTransferToken(100); // 1%
        fot.mint(maker, 1_000_000e18);
        vm.prank(maker);
        fot.approve(address(aqua), type(uint256).max);

        PayingTaker taker = new PayingTaker(IAqua(address(aqua)));
        fot.mint(address(taker), 10_000e18);
        tokenB.mint(address(taker), 10_000e18);
        taker.approveAqua(address(fot));
        taker.approveAqua(address(tokenB));

        SwapMandate memory m = SwapMandate({
            maker: maker,
            token0: address(fot),
            token1: address(tokenB),
            feeBps: FEE_BPS,
            maxOut0: NO_CEILING,
            maxOut1: NO_CEILING,
            expiry: EXPIRY,
            agent: address(taker),
            salt: "fot",
            venues: new Venue[](0)
        });
        address[] memory tokens = new address[](2);
        tokens[0] = address(fot);
        tokens[1] = address(tokenB);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = RESERVE_A;
        amounts[1] = RESERVE_B;
        vm.prank(maker);
        aqua.ship(address(app), abi.encode(m), tokens, amounts);

        uint256 makerBefore = fot.balanceOf(maker);
        taker.swap(app, m, true, AMOUNT_IN, 0, address(taker));

        (uint256 ledger,) = aqua.rawBalances(maker, address(app), _hash(m), address(fot));
        uint256 actuallyReceived = fot.balanceOf(maker) - makerBefore;

        assertEq(ledger, RESERVE_A + AMOUNT_IN, "the ledger credits the nominal amount");
        assertEq(actuallyReceived, AMOUNT_IN * 9900 / 10_000, "the wallet received one percent less");
        assertGt(ledger - RESERVE_A, actuallyReceived, "ledger and wallet drift apart on every swap");
    }

    /// @dev A sufficient ledger is not a promise of settlement. The tokens are pulled from the
    ///      maker's own wallet, so solvency is the maker's problem and neither Aqua's nor ours.
    function test_ASwapFailsWhenTheMakersWalletNoLongerHoldsTheTokens() public {
        SwapMandate memory m = _mandate(address(agentTaker), NO_CEILING, NO_CEILING, "drained");
        _ship(m);

        uint256 held = tokenB.balanceOf(maker);
        vm.prank(maker);
        tokenB.transfer(address(0xDEAD), held);

        // The quote still answers: it reads the ledger, which knows nothing about the wallet.
        assertGt(app.quoteExactIn(m, true, AMOUNT_IN), 0, "the quote reads virtual balances");

        // 1inch's SafeERC20 swallows the token's own reason, so this is all a caller learns.
        vm.expectRevert(abi.encodeWithSignature("SafeTransferFromFailed()"));
        agentTaker.swap(app, m, true, AMOUNT_IN, 0, address(agentTaker));
    }

    // --------------------------------------------------------------------------------------
    // Helpers
    // --------------------------------------------------------------------------------------

    function _mandate(address agent, uint256 maxOut0, uint256 maxOut1, bytes32 salt)
        private
        view
        returns (SwapMandate memory)
    {
        return SwapMandate({
            maker: maker,
            token0: address(tokenA),
            token1: address(tokenB),
            feeBps: FEE_BPS,
            maxOut0: maxOut0,
            maxOut1: maxOut1,
            expiry: EXPIRY,
            agent: agent,
            salt: salt,
            venues: new Venue[](0)
        });
    }

    function _ship(SwapMandate memory m) private returns (bytes32) {
        address[] memory tokens = new address[](2);
        tokens[0] = m.token0;
        tokens[1] = m.token1;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = RESERVE_A;
        amounts[1] = RESERVE_B;
        vm.prank(m.maker);
        return aqua.ship(address(app), abi.encode(m), tokens, amounts);
    }

    function _hash(SwapMandate memory m) private pure returns (bytes32) {
        return keccak256(abi.encode(m));
    }

    /// @dev The curve, restated here so a ceiling can be placed exactly on the output rather
    ///      than near it. `test_TheCurveIsConstantProductAfterFee` pins the formula itself
    ///      against a literal, so this helper drifting would not go unnoticed.
    function _quoteOffChain(uint256 balanceIn, uint256 balanceOut, uint256 amountIn)
        private
        pure
        returns (uint256)
    {
        uint256 withFee = amountIn * (10_000 - FEE_BPS) / 10_000;
        return withFee * balanceOut / (balanceIn + withFee);
    }

    /// @dev Enough of both tokens, and an approval to Aqua rather than to the app, because that
    ///      is where `push` moves them from.
    function _fund(address taker) private {
        tokenA.mint(taker, 10_000e18);
        tokenB.mint(taker, 10_000e18);
        PayingTaker(taker).approveAqua(address(tokenA));
        PayingTaker(taker).approveAqua(address(tokenB));
    }
}
