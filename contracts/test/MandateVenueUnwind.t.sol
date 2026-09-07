// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, stdError} from "forge-std/Test.sol";

import {Aqua} from "@1inch/aqua/Aqua.sol";
import {IAqua} from "@1inch/aqua/interfaces/IAqua.sol";

import {HelicoMandateSwap, SwapMandate, Venue} from "../src/HelicoMandateSwap.sol";
import {MockLendingPool, MockReceipt} from "./MandateVenues.sol";
import {PayingTaker, TestToken} from "./MandateTakers.sol";

/// @notice The unwind path: what happens when the maker's capital is not in their wallet.
///
/// @dev Everything in `HelicoMandateSwap.t.sol` ships `venues: new Venue[](0)`, which is the
///      documented no-op. So the whole of `_cover`, `_venueFor` and the venue half of
///      `_checkVenues` was reached by no test at all until this file existed. Every case below
///      names a rule the contract states about itself in prose, and checks the code keeps it.
contract MandateVenueUnwindTest is Test {
    Aqua aqua;
    HelicoMandateSwap app;

    TestToken tokenA;
    TestToken tokenB;

    MockLendingPool pool;
    MockReceipt receiptB;

    PayingTaker taker;

    address maker = address(0xA11CE);

    uint256 constant RESERVE_A = 1000e18;
    uint256 constant RESERVE_B = 1000e18;
    uint256 constant SUPPLIED = 500e18;
    uint256 constant FEE_BPS = 30;
    uint256 constant AMOUNT_IN = 100e18;
    uint64 constant EXPIRY = 2_000_000;
    uint256 constant NO_CEILING = type(uint256).max;

    function setUp() public {
        vm.warp(1_000_000);

        aqua = new Aqua();
        app = new HelicoMandateSwap(IAqua(address(aqua)));

        tokenA = new TestToken("Token A", "TKA");
        tokenB = new TestToken("Token B", "TKB");

        pool = new MockLendingPool();
        receiptB = pool.list(address(tokenB), "aTKB");

        // The maker's token0 sits in the wallet; their token1 is supplied to the market, so a
        // swap that pays out token1 has to unwind before it can settle.
        tokenA.mint(maker, 1_000_000e18);
        tokenB.mint(maker, SUPPLIED);

        vm.startPrank(maker);
        tokenA.approve(address(aqua), type(uint256).max);
        tokenB.approve(address(aqua), type(uint256).max);
        receiptB.approve(address(aqua), type(uint256).max);
        tokenB.approve(address(pool), type(uint256).max);
        pool.supply(address(tokenB), SUPPLIED, maker, 0);
        vm.stopPrank();

        taker = new PayingTaker(IAqua(address(aqua)));
        tokenA.mint(address(taker), 10_000e18);
        tokenB.mint(address(taker), 10_000e18);
        taker.approveAqua(address(tokenA));
        taker.approveAqua(address(tokenB));
    }

    // ------------------------------------------------------------------------------------
    // The path itself
    // ------------------------------------------------------------------------------------

    function test_AnUnwindTopsUpTheWalletAndPaysTheSwap() public {
        SwapMandate memory m = _mandate(_venues(address(pool), address(receiptB)), "unwind");
        _ship(m, address(receiptB), SUPPLIED);

        assertEq(tokenB.balanceOf(maker), 0, "maker starts with nothing in the wallet");

        uint256 out = taker.swap(app, m, true, AMOUNT_IN, 0, address(taker));

        assertGt(out, 0, "the swap paid out");
        assertEq(pool.withdrawCalls(), 1, "exactly one unwind");
        assertEq(tokenB.balanceOf(address(taker)), 10_000e18 + out, "the taker was paid");
        assertEq(receiptB.balanceOf(address(app)), 0, "no receipt retained");
        assertEq(receiptB.balanceOf(maker), SUPPLIED - out, "only the shortfall was unwound");
    }

    /// @dev `_cover`: "The wallet is spent first, always."
    function test_TheWalletIsSpentBeforeAnyLendingMarket() public {
        tokenB.mint(maker, 1_000_000e18);

        SwapMandate memory m = _mandate(_venues(address(pool), address(receiptB)), "wallet-first");
        _ship(m, address(receiptB), SUPPLIED);

        taker.swap(app, m, true, AMOUNT_IN, 0, address(taker));

        assertEq(pool.withdrawCalls(), 0, "a funded wallet never touched the market");
        assertEq(receiptB.balanceOf(maker), SUPPLIED, "the position was left earning");
    }

    // ------------------------------------------------------------------------------------
    // The rules the contract states about itself
    // ------------------------------------------------------------------------------------

    /// @dev `_cover`: "a market being paused or illiquid cannot break a swap that did not need
    ///      it ... it is what keeps a dependency we added from reaching swaps that do not
    ///      depend on it." A maker's debt is such a dependency.
    function test_ASwapTheWalletCoversIsNotBlockedByDebtAtAVenue() public {
        tokenB.mint(maker, 1_000_000e18);
        pool.setDebt(maker, 1);

        SwapMandate memory m = _mandate(_venues(address(pool), address(receiptB)), "debt-idle");
        _ship(m, address(receiptB), SUPPLIED);

        taker.swap(app, m, true, AMOUNT_IN, 0, address(taker));

        assertEq(pool.withdrawCalls(), 0, "the market was never needed, so its state never mattered");
    }

    /// @dev `MakerHasDebt`: "Refused rather than attempted ... the withdrawal would fail anyway
    ///      -- but as the market's error, from inside our call, after the mandate looked fine."
    ///      That promise has to hold for the venue the swap actually draws on.
    function test_DebtAtTheVenueBeingUnwoundIsRefusedByName() public {
        MockLendingPool dry = new MockLendingPool();
        MockReceipt dryReceipt = dry.list(address(tokenB), "dTKB");

        pool.setDebt(maker, 50_000e18);

        Venue[] memory vs = new Venue[](2);
        vs[0] = Venue({pool: address(dry), receipt0: address(0), receipt1: address(dryReceipt)});
        vs[1] = Venue({pool: address(pool), receipt0: address(0), receipt1: address(receiptB)});

        SwapMandate memory m = _mandate(vs, "debt-second-venue");
        _ship(m, address(receiptB), SUPPLIED);

        vm.expectRevert(abi.encodeWithSelector(HelicoMandateSwap.MakerHasDebt.selector, maker, 50_000e18));
        taker.swap(app, m, true, AMOUNT_IN, 0, address(taker));
    }

    /// @dev `_venueFor`: "The first permitted venue that can actually pay." A venue the mandate
    ///      has no budget for cannot pay, and must not end the search.
    function test_AVenueWithNoBudgetFallsThroughToTheNextOne() public {
        MockLendingPool second = new MockLendingPool();
        MockReceipt secondReceipt = second.list(address(tokenB), "sTKB");

        // The maker's whole position is at the second venue; the first is listed but unfunded.
        vm.startPrank(maker);
        secondReceipt.approve(address(aqua), type(uint256).max);
        vm.stopPrank();
        tokenB.mint(address(this), SUPPLIED);
        tokenB.approve(address(second), type(uint256).max);
        second.supply(address(tokenB), SUPPLIED, maker, 0);

        Venue[] memory vs = new Venue[](2);
        vs[0] = Venue({pool: address(pool), receipt0: address(0), receipt1: address(receiptB)});
        vs[1] = Venue({pool: address(second), receipt0: address(0), receipt1: address(secondReceipt)});

        SwapMandate memory m = _mandate(vs, "fallback");

        address[] memory tokens = new address[](4);
        tokens[0] = m.token0;
        tokens[1] = m.token1;
        tokens[2] = address(receiptB);
        tokens[3] = address(secondReceipt);
        uint256[] memory amounts = new uint256[](4);
        amounts[0] = RESERVE_A;
        amounts[1] = RESERVE_B;
        amounts[2] = 1e18; // far short of any deficit
        amounts[3] = SUPPLIED;
        vm.prank(maker);
        aqua.ship(address(app), abi.encode(m), tokens, amounts);

        uint256 out = taker.swap(app, m, true, AMOUNT_IN, 0, address(taker));

        assertGt(out, 0, "the funded venue paid");
        assertEq(second.withdrawCalls(), 1, "the second venue was reached");
        assertEq(pool.withdrawCalls(), 0, "the unfunded venue was skipped, not fatal");
    }

    /// @dev `withdraw` burns whatever receipt the *pool* recognises, while every guard in
    ///      `_cover` measures the receipt the *mandate* named. Two markets on one chain issue
    ///      two different receipts for the same asset, and both answer `UNDERLYING_ASSET_ADDRESS`
    ///      identically -- so the asset check alone lets the two come apart, and what leaves the
    ///      contract is not what the guard is watching.
    function test_AReceiptFromAnotherMarketIsRefused() public {
        MockLendingPool other = new MockLendingPool();
        MockReceipt otherReceipt = other.list(address(tokenB), "oTKB");

        // Both receipts name the same underlying, which is all the asset check can see.
        assertEq(receiptB.UNDERLYING_ASSET_ADDRESS(), otherReceipt.UNDERLYING_ASSET_ADDRESS());

        // The app is holding this market's receipts, which `_cover` documents it must tolerate:
        // "a receipt left here by any earlier call belongs to somebody else".
        vm.prank(maker);
        receiptB.transfer(address(app), 100e18);

        // A mandate naming the real market, with the other market's receipt beside it.
        SwapMandate memory m = _mandate(_venues(address(pool), address(otherReceipt)), "foreign-receipt");

        vm.startPrank(maker);
        tokenB.mint(maker, SUPPLIED);
        tokenB.approve(address(other), type(uint256).max);
        other.supply(address(tokenB), SUPPLIED, maker, 0);
        otherReceipt.approve(address(aqua), type(uint256).max);
        vm.stopPrank();
        _ship(m, address(otherReceipt), SUPPLIED);

        vm.expectRevert(
            abi.encodeWithSelector(
                HelicoMandateSwap.ReceiptIsNotFrom.selector, address(otherReceipt), address(pool)
            )
        );
        taker.swap(app, m, true, AMOUNT_IN, 0, address(taker));

        assertEq(receiptB.balanceOf(address(app)), 100e18, "the stranded position was not touched");
    }

    /// @dev `quoteExactIn`: "a quote that answers for a mandate the swap would refuse sends an
    ///      agent to build a transaction that cannot land."
    function test_AQuoteRefusesWhatTheSwapRefuses() public {
        // Nothing is supplied to this market, so it cannot cover any deficit.
        MockLendingPool empty = new MockLendingPool();
        MockReceipt emptyReceipt = empty.list(address(tokenB), "eTKB");

        SwapMandate memory m = _mandate(_venues(address(empty), address(emptyReceipt)), "quote-parity");
        _ship(m, address(emptyReceipt), SUPPLIED);

        vm.expectRevert(
            abi.encodeWithSelector(
                HelicoMandateSwap.NoVenueCanCover.selector, address(tokenB), _expectedOut()
            )
        );
        taker.swap(app, m, true, AMOUNT_IN, 0, address(taker));

        vm.expectRevert(
            abi.encodeWithSelector(
                HelicoMandateSwap.NoVenueCanCover.selector, address(tokenB), _expectedOut()
            )
        );
        app.quoteExactIn(m, true, AMOUNT_IN);
    }

    // ------------------------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------------------------

    function _venues(address pool_, address receipt1) private pure returns (Venue[] memory vs) {
        vs = new Venue[](1);
        vs[0] = Venue({pool: pool_, receipt0: address(0), receipt1: receipt1});
    }

    function _mandate(Venue[] memory venues, bytes32 salt) private view returns (SwapMandate memory) {
        return SwapMandate({
            maker: maker,
            token0: address(tokenA),
            token1: address(tokenB),
            feeBps: FEE_BPS,
            maxOut0: NO_CEILING,
            maxOut1: NO_CEILING,
            expiry: EXPIRY,
            agent: address(taker),
            salt: salt,
            venues: venues
        });
    }

    function _ship(SwapMandate memory m, address receipt, uint256 receiptAmount) private returns (bytes32) {
        address[] memory tokens = new address[](3);
        tokens[0] = m.token0;
        tokens[1] = m.token1;
        tokens[2] = receipt;
        uint256[] memory amounts = new uint256[](3);
        amounts[0] = RESERVE_A;
        amounts[1] = RESERVE_B;
        amounts[2] = receiptAmount;
        vm.prank(m.maker);
        return aqua.ship(address(app), abi.encode(m), tokens, amounts);
    }

    /// @dev The constant-product answer, computed independently of the contract.
    function _expectedOut() private pure returns (uint256) {
        uint256 amountInWithFee = AMOUNT_IN * (10_000 - FEE_BPS) / 10_000;
        return amountInWithFee * RESERVE_B / (RESERVE_A + amountInWithFee);
    }
}
