// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {Aqua} from "@1inch/aqua/Aqua.sol";
import {IAqua} from "@1inch/aqua/interfaces/IAqua.sol";

import {ReceiptKind} from "../src/ReceiptMath.sol";
import {HelicoMandateSwap, SwapMandate, Venue} from "../src/HelicoMandateSwap.sol";
import {MockSharePricedPool, MockSharePricedReceipt} from "./MandateVenues.sol";
import {PayingTaker, TestToken} from "./MandateTakers.sol";

/// @notice A receipt whose unit is not the underlying's unit — the assumption #179 left open.
///
/// @dev `_cover` pulled `deficit` of the receipt and withdrew `deficit` of the underlying, and
///      `_venueFor` compared a receipt budget and a receipt balance against the same `deficit`.
///      All four are correct for a rebasing aToken and wrong for anything share-priced, in a way
///      that is not a rounding error: a seasoned cToken sits near 0.022, so the numbers differ by
///      two orders of magnitude.
///
///      The venue audit left it deliberately, because `ILendingVenue` is Aave-shaped and the
///      assumption held for everything it could point at. **This file is that day arriving.**
///      `ReceiptKind.SharePriced` converts through `previewWithdraw`, and the cases below check
///      the conversion in both directions rather than only the one that happens to be safe.
contract MandateSharePricedReceiptTest is Test {
    Aqua aqua;
    HelicoMandateSwap app;

    TestToken tokenA;
    TestToken tokenB;

    MockSharePricedPool pool;
    MockSharePricedReceipt receiptB;

    PayingTaker taker;

    address maker = address(0xA11CE);

    uint256 constant RESERVE_A = 1000e18;
    uint256 constant RESERVE_B = 1000e18;
    uint256 constant SUPPLIED = 500e18;
    uint256 constant FEE_BPS = 30;
    uint256 constant AMOUNT_IN = 100e18;
    uint64 constant EXPIRY = 2_000_000;
    uint256 constant NO_CEILING = type(uint256).max;

    /// @dev Four underlying to the share. Chosen well away from par in the direction that makes
    ///      the old code pull four times too much receipt — visible rather than subtle.
    uint256 constant RATE = 4e18;

    function setUp() public {
        vm.warp(1_000_000);

        aqua = new Aqua();
        app = new HelicoMandateSwap(IAqua(address(aqua)), address(0));

        tokenA = new TestToken("Token A", "TKA");
        tokenB = new TestToken("Token B", "TKB");

        pool = new MockSharePricedPool();
        receiptB = pool.list(address(tokenB), "sTKB", RATE);

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

    function _venues() private view returns (Venue[] memory vs) {
        vs = new Venue[](1);
        vs[0] = Venue({
            pool: address(pool),
            receipt0: address(0),
            receipt1: address(receiptB),
            kind: ReceiptKind.SharePriced
        });
    }

    function _mandate(bytes32 salt) private view returns (SwapMandate memory) {
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
            venues: _venues()
        });
    }

    function _ship(SwapMandate memory m, uint256 receiptBudget) private {
        address[] memory tokens = new address[](3);
        tokens[0] = m.token0;
        tokens[1] = m.token1;
        tokens[2] = address(receiptB);
        uint256[] memory amounts = new uint256[](3);
        amounts[0] = RESERVE_A;
        amounts[1] = RESERVE_B;
        amounts[2] = receiptBudget;
        vm.prank(m.maker);
        aqua.ship(address(app), abi.encode(m), tokens, amounts);
    }

    // ── the conversion ────────────────────────────────────────────────────────

    /// @dev The whole point. The wallet is empty, the position is share-priced, and the unwind
    ///      burns the number of shares that redeems for the shortfall — not the shortfall itself.
    function test_AnUnwindBurnsSharesRatherThanUnderlyingUnits() public {
        SwapMandate memory m = _mandate("share-priced");
        _ship(m, receiptB.balanceOf(maker));

        assertEq(tokenB.balanceOf(maker), 0, "the maker's wallet is empty");
        uint256 sharesBefore = receiptB.balanceOf(maker);

        uint256 out = taker.swap(app, m, true, AMOUNT_IN, 0, address(taker));
        assertGt(out, 0, "the swap paid out");

        uint256 burned = sharesBefore - receiptB.balanceOf(maker);
        uint256 expected = (out * 1e18 + RATE - 1) / RATE;

        assertEq(burned, expected, "shares burned are the conversion of the shortfall");
        assertLt(burned, out, "fewer shares than underlying, because a share is worth more");
        assertEq(receiptB.balanceOf(address(app)), 0, "no receipt retained");

        // **The assertion that actually catches the regression.** Above par, over-pulling is
        // invisible in the maker's wallet: `_cover` hands the excess straight back, so the
        // balance nets out to the true cost either way. What does not come back is the ledger
        // budget — `pull` decrements it by what was asked for, and `dock` is the only thing that
        // restores it. Measured without this, the first version of this test passed with the
        // conversion disabled, which is the quiet drain #179 described.
        (uint248 budgetAfter,) =
            aqua.rawBalances(maker, address(app), keccak256(abi.encode(m)), address(receiptB));
        assertEq(uint256(budgetAfter), sharesBefore - expected, "the ledger was debited the converted amount");

        emit log_named_uint("paid out (underlying)", out);
        emit log_named_uint("shares burned        ", burned);
        emit log_named_uint("what 1:1 would burn  ", out);
    }

    /// @dev The other direction, which used to fail loudly rather than quietly. Below par a share
    ///      is worth less than one underlying, so covering a shortfall costs **more** shares than
    ///      the old arithmetic pulled — and the withdrawal fell short.
    ///
    ///      A second market rather than `setRate` on the first: changing the rate after the maker
    ///      supplied would shrink the position they already hold, and the test would then be about
    ///      an underfunded position rather than about the conversion. The first version of this
    ///      test did exactly that and failed for that reason.
    function test_TheConversionAlsoHoldsBelowPar() public {
        uint256 cheap = 0.25e18;
        MockSharePricedPool below = new MockSharePricedPool();
        MockSharePricedReceipt receiptC = below.list(address(tokenB), "cTKB", cheap);

        tokenB.mint(maker, SUPPLIED);
        vm.startPrank(maker);
        tokenB.approve(address(below), type(uint256).max);
        receiptC.approve(address(aqua), type(uint256).max);
        below.supply(address(tokenB), SUPPLIED, maker, 0);
        vm.stopPrank();

        SwapMandate memory m = _mandate("below-par");
        m.venues[0].pool = address(below);
        m.venues[0].receipt1 = address(receiptC);

        address[] memory tokens = new address[](3);
        tokens[0] = m.token0;
        tokens[1] = m.token1;
        tokens[2] = address(receiptC);
        uint256[] memory amounts = new uint256[](3);
        amounts[0] = RESERVE_A;
        amounts[1] = RESERVE_B;
        amounts[2] = receiptC.balanceOf(maker);
        vm.prank(maker);
        aqua.ship(address(app), abi.encode(m), tokens, amounts);

        uint256 sharesBefore = receiptC.balanceOf(maker);
        uint256 out = taker.swap(app, m, true, AMOUNT_IN, 0, address(taker));
        uint256 burned = sharesBefore - receiptC.balanceOf(maker);

        assertEq(burned, (out * 1e18 + cheap - 1) / cheap, "shares burned follow the rate down");
        assertGt(burned, out, "more shares than underlying, because a share is worth less");
    }

    /// @dev The budget is denominated in the receipt, so the check that a venue can cover a
    ///      shortfall has to compare shares with shares. A budget large enough in underlying
    ///      units and too small in shares is exactly the case that used to pass the search and
    ///      then revert inside Aqua with an arithmetic panic nobody could read.
    function test_TheBudgetIsMeasuredInSharesNotUnderlying() public {
        receiptB.setRate(0.25e18);

        SwapMandate memory m = _mandate("budget");
        // Enough if a share were an underlying unit; a quarter of what is actually needed.
        uint256 tooSmall = AMOUNT_IN;
        _ship(m, tooSmall);

        vm.expectPartialRevert(HelicoMandateSwap.NoVenueCanCover.selector);
        taker.swap(app, m, true, AMOUNT_IN, 0, address(taker));
    }

    /// @dev Mislabelling a share-priced receipt as `Rebasing` does **not** fail loudly, and that
    ///      is worth pinning rather than discovering. The app pulls `out` of the receipt, the
    ///      market burns what `out` underlying actually costs, and `_cover` hands the difference
    ///      back — so the swap settles and the maker's ledger budget drained four times faster
    ///      than their position did.
    ///
    ///      Nothing here can catch that: the receipt answers `UNDERLYING_ASSET_ADDRESS` and the
    ///      pool agrees it is theirs, which is all `_requireReceiptFor` asks. The `kind` is a
    ///      claim the maker makes about their own venue, and the only defence is that it is
    ///      their own budget being spent.
    function test_CallingAShareReceiptRebasingOverpullsAndRefundsRatherThanReverting() public {
        SwapMandate memory m = _mandate("mislabelled");
        m.venues[0].kind = ReceiptKind.Rebasing;
        _ship(m, receiptB.balanceOf(maker));

        uint256 sharesBefore = receiptB.balanceOf(maker);
        uint256 out = taker.swap(app, m, true, AMOUNT_IN, 0, address(taker));
        uint256 moved = sharesBefore - receiptB.balanceOf(maker);

        assertEq(moved, (out * 1e18 + RATE - 1) / RATE, "the position still moved by the true cost");
        assertEq(receiptB.balanceOf(address(app)), 0, "and the over-pull went home rather than sticking");
    }
}
