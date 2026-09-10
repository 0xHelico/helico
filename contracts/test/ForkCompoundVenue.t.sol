// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Aqua} from "@1inch/aqua/Aqua.sol";
import {IAqua} from "@1inch/aqua/interfaces/IAqua.sol";

import {CompoundVenue, ReserveData} from "../src/CompoundVenue.sol";
import {IComet} from "../src/IComet.sol";
import {ReceiptKind} from "../src/ReceiptMath.sol";
import {HelicoMandateSwap, SwapMandate, Venue} from "../src/HelicoMandateSwap.sol";
import {PayingTaker} from "./MandateTakers.sol";

/// @notice `supplyTo` is absent from `IComet` because the venue never credits anybody but itself.
///         The attack below needs it, so the test declares it rather than widening the interface.
interface ICometSupplyTo {
    function supplyTo(address dst, address asset, uint256 amount) external;
}

/// @notice A maker paid out of Compound, through the app that only knew how to read Aave.
///
/// @dev The claim being tested is the one that made the whole file worth writing: the enclave is
///      supposed to compare supply rates and move capital to the best market, and until this venue
///      existed every market it could compare was Aave-shaped. A comparison inside one protocol
///      family is a market picker, not a yield optimiser.
///
///      What blocked it was a **name**. `_requireReceiptFor` asks the receipt for
///      `UNDERLYING_ASSET_ADDRESS()`, which is how an Aave aToken spells it; Comet's base token
///      spells it `baseToken()`. Both apps carrying that line are deployed and neither is
///      upgradeable, so the venue answers the Aave spelling itself and is its own receipt.
///
///      Real Comet, real USDC, real WETH, on a fork of Arbitrum One. The maker's wallet is
///      **empty** of the token being paid out — every unit of it is inside Compound — and a taker
///      is still paid, because the fill unwinds exactly the shortfall on the way through.
contract ForkCompoundVenueTest is Test {
    IERC20 constant USDC = IERC20(0xaf88d065e77c8cC2239327C5EDb3A432268e5831);
    IERC20 constant WETH = IERC20(0x82aF49447D8a07e3bd95BD0d56f35241523fBab1);
    IComet constant COMET = IComet(0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf);
    address constant USDC_WHALE = 0x47c031236e19d024b42f8AE6780E44A573170703;
    address constant WETH_WHALE = 0x70d95587d40A2caf56bd97485aB3Eec10Bee6336;

    Aqua aqua;
    HelicoMandateSwap app;
    CompoundVenue venue;
    PayingTaker taker;

    address maker = address(0xA11CE);
    /// @dev A second supplier who does nothing. Without them this venue has one holder, and a
    ///      maker who burns too many shares hands the surplus back to themselves — so every value
    ///      check nets out and passes with the conversion removed. They are the witness.
    address bystander = address(0xB0B);

    uint256 constant CAPITAL = 60_000e6;
    uint256 constant BYSTANDER_CAPITAL = 10_000e6;
    uint256 constant RESERVE_USDC = 50_000e6;
    uint256 constant RESERVE_WETH = 20e18;
    uint256 constant FEE_BPS = 30;
    uint256 constant NO_CEILING = type(uint256).max;
    uint256 constant AMOUNT_IN = 1e18;

    bool forked;
    uint64 expiry;

    function setUp() public {
        try vm.createSelectFork("arbitrum") {
            forked = true;
        } catch {
            forked = false;
            return;
        }

        aqua = new Aqua();
        app = new HelicoMandateSwap(IAqua(address(aqua)), address(0));
        venue = new CompoundVenue(COMET);
        // A year, not a month: the accrual test warps a hundred and eighty days forward and a
        // mandate that expires under it fails as `MandateExpired`, which reads like a bug in the
        // venue and is a bug in the fixture.
        expiry = uint64(block.timestamp + 365 days);

        vm.prank(USDC_WHALE);
        USDC.transfer(maker, CAPITAL);
        vm.prank(WETH_WHALE);
        WETH.transfer(maker, RESERVE_WETH);

        vm.startPrank(maker);
        // Every unit of USDC goes to work. This is the position the product describes, and it is
        // what makes the assertion below mean something.
        USDC.approve(address(venue), type(uint256).max);
        venue.supply(address(USDC), CAPITAL, maker, 0);

        USDC.approve(address(aqua), type(uint256).max);
        WETH.approve(address(aqua), type(uint256).max);
        // The receipt is pulled through Aqua like any other token, so Aqua needs the allowance.
        venue.approve(address(aqua), type(uint256).max);
        vm.stopPrank();

        vm.prank(USDC_WHALE);
        USDC.transfer(bystander, BYSTANDER_CAPITAL);
        vm.startPrank(bystander);
        USDC.approve(address(venue), type(uint256).max);
        venue.supply(address(USDC), BYSTANDER_CAPITAL, bystander, 0);
        vm.stopPrank();

        taker = new PayingTaker(IAqua(address(aqua)));
        vm.prank(WETH_WHALE);
        WETH.transfer(address(taker), 10e18);
        taker.approveAqua(address(WETH));
        taker.approveAqua(address(USDC));
    }

    modifier onlyForked() {
        if (!forked) {
            emit log("SKIP: no `arbitrum` RPC endpoint configured");
            return;
        }
        _;
    }

    function _venues() internal view returns (Venue[] memory v) {
        v = new Venue[](1);
        // receipt0 is the receipt for token0 (USDC); token1 is WETH and this maker never lends it.
        // The pool and the receipt are the same address, which is the whole design.
        v[0] = Venue({
            pool: address(venue),
            receipt0: address(venue),
            receipt1: address(0),
            kind: ReceiptKind.SharePriced
        });
    }

    function _mandate() internal view returns (SwapMandate memory) {
        return SwapMandate({
            maker: maker,
            token0: address(USDC),
            token1: address(WETH),
            feeBps: FEE_BPS,
            maxOut0: NO_CEILING,
            maxOut1: NO_CEILING,
            expiry: expiry,
            agent: address(taker),
            salt: "compound",
            venues: _venues()
        });
    }

    function _ship() internal {
        SwapMandate memory m = _mandate();
        address[] memory tokens = new address[](3);
        uint256[] memory amounts = new uint256[](3);
        tokens[0] = address(USDC);
        amounts[0] = RESERVE_USDC;
        tokens[1] = address(WETH);
        amounts[1] = RESERVE_WETH;
        tokens[2] = address(venue);
        amounts[2] = venue.balanceOf(maker);
        vm.prank(maker);
        aqua.ship(address(app), abi.encode(m), tokens, amounts);
    }

    // ── the claim ─────────────────────────────────────────────────────────────

    /// @dev The whole file, in one comparison: the maker's wallet held no USDC at all, and the
    ///      taker was paid USDC anyway, out of a Compound position that was earning until the
    ///      moment the swap needed it.
    function test_ATakerIsPaidOutOfCompound() public onlyForked {
        _ship();

        assertEq(USDC.balanceOf(maker), 0, "the maker's wallet holds no USDC");
        assertGt(venue.balanceOf(maker), 0, "all of it is in Compound, through this venue");

        uint256 sharesBefore = venue.balanceOf(maker);
        // Measured, not assumed to be `CAPITAL`: Comet accrues and the virtual offset costs a wei,
        // so a constant here would be testing the fixture's arithmetic rather than the venue's.
        uint256 valueBefore = venue.previewRedeem(sharesBefore);
        uint256 bystanderBefore = venue.previewRedeem(venue.balanceOf(bystander));
        uint256 takerBefore = USDC.balanceOf(address(taker));

        uint256 out = taker.swap(app, _mandate(), false, AMOUNT_IN, 0, address(taker));

        assertGt(out, 0, "the swap paid out");
        assertEq(USDC.balanceOf(address(taker)) - takerBefore, out, "the taker was paid, on chain");
        assertLt(venue.balanceOf(maker), sharesBefore, "and the Compound position paid for it");
        assertEq(WETH.balanceOf(maker), RESERVE_WETH + AMOUNT_IN, "the maker holds the WETH they bought");
        assertEq(USDC.balanceOf(address(app)), 0, "the app kept no USDC");
        assertEq(venue.balanceOf(address(app)), 0, "and no receipt");

        // **The assertion that survives a mutation, and the reason it is here.** Counting shares
        // burned proves nothing on its own: the app asks this venue what a shortfall costs and the
        // venue burns what it just quoted, so a wrong conversion is wrong in both places at once
        // and cancels. What cannot cancel is value — the maker's remaining position plus what left
        // it must be what they started with. One unit of slack for the rounding that is deliberately
        // against the maker.
        uint256 valueAfter = venue.previewRedeem(venue.balanceOf(maker));
        // Three units of slack on sixty thousand USDC. `previewWithdraw` rounds up and the virtual
        // offset costs a wei on each side, both deliberately against the maker — an exact equality
        // here would be a test that only passes because the rounding happens to cancel today.
        assertApproxEqAbs(
            valueAfter + out, valueBefore, 3, "the position lost exactly what the taker was paid"
        );
        assertApproxEqAbs(
            venue.previewRedeem(venue.balanceOf(bystander)), bystanderBefore, 3, "and nobody else gained"
        );

        emit log_named_uint("paid to taker (USDC)", out);
        emit log_named_uint("shares before       ", sharesBefore);
        emit log_named_uint("shares after        ", venue.balanceOf(maker));
    }

    /// @dev The same fill, after the share price has moved away from par. At day zero a share is
    ///      worth one USDC and a conversion that does nothing is indistinguishable from one that
    ///      works — which is how #296's first test passed with the fix removed. Here interest has
    ///      accrued first, so the two numbers are genuinely different and the value check bites.
    function test_ACoverAfterInterestHasAccrued() public onlyForked {
        _ship();

        vm.warp(block.timestamp + 180 days);
        vm.roll(block.number + 1);

        uint256 valueBefore = venue.previewRedeem(venue.balanceOf(maker));
        assertGt(valueBefore, CAPITAL, "the position has grown, so a share is no longer one USDC");

        uint256 sharesBefore = venue.balanceOf(maker);
        uint256 bystanderBefore = venue.previewRedeem(venue.balanceOf(bystander));
        uint256 out = taker.swap(app, _mandate(), false, AMOUNT_IN, 0, address(taker));
        uint256 burned = sharesBefore - venue.balanceOf(maker);

        assertLt(burned, out, "fewer shares than USDC, because a share is now worth more than one");

        uint256 valueAfter = venue.previewRedeem(venue.balanceOf(maker));
        assertApproxEqAbs(valueAfter + out, valueBefore, 3, "and the position lost exactly what left it");
        // The witness. Burning more shares than the withdrawal cost cannot hurt a sole holder —
        // the surplus returns to them. It shows up here, as a bystander who did nothing getting
        // richer, and this is the only assertion in the file a self-consistent wrong conversion
        // cannot satisfy.
        assertApproxEqAbs(
            venue.previewRedeem(venue.balanceOf(bystander)), bystanderBefore, 3, "and nobody else gained"
        );

        emit log_named_uint("position before", valueBefore);
        emit log_named_uint("paid to taker  ", out);
        emit log_named_uint("shares burned  ", burned);
        emit log_named_uint("what 1:1 burns ", out);
    }

    /// @dev **A deposit that mints nothing.** Found by @rifkyeasy reviewing #317, measured on a
    ///      fork rather than argued about, and brought back here as a test because the scratch that
    ///      produced it was thrown away.
    ///
    ///      The virtual `+1` offset makes the classic first-depositor attack unprofitable: a holder
    ///      of one share can never own more than half the pool, so the donor loses more than the
    ///      victim does. That property holds and is worth having. What it does **not** do is stop
    ///      the victim losing — donate enough and an honest deposit rounds to zero shares while
    ///      `supply` returns without complaint.
    ///
    ///      "Nobody gains" is not "nobody loses", and the guard is one line.
    function test_ADepositThatWouldMintNothingIsRefused() public onlyForked {
        address attacker = address(0xBAD);
        address victim = address(0x71C);

        vm.prank(USDC_WHALE);
        USDC.transfer(attacker, 30_000e6 + 1);
        vm.prank(USDC_WHALE);
        USDC.transfer(victim, 1_000e6);

        // A **fresh** venue: the attack needs the attacker to be the first depositor, and the
        // one in `setUp` already holds the maker's sixty thousand. Using that one is why the first
        // version of this test did not revert — the ratio was nowhere near degenerate.
        CompoundVenue empty = new CompoundVenue(COMET);

        vm.startPrank(attacker);
        USDC.approve(address(empty), type(uint256).max);
        empty.supply(address(USDC), 1, attacker, 0);
        assertEq(empty.balanceOf(attacker), 1, "one wei bought one share");

        // The donation goes to the venue's Comet position directly, so `totalAssets` rises while
        // `totalSupply` does not. Nothing about it is exotic — Comet lets anyone supply on
        // another address's behalf.
        USDC.approve(address(COMET), type(uint256).max);
        ICometSupplyTo(address(COMET)).supplyTo(address(empty), address(USDC), 30_000e6);
        vm.stopPrank();

        assertGt(empty.totalAssets(), 29_000e6, "the pool now holds far more than its one share");

        vm.startPrank(victim);
        USDC.approve(address(empty), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(CompoundVenue.DepositMintsNothing.selector, 1_000e6));
        empty.supply(address(USDC), 1_000e6, victim, 0);
        vm.stopPrank();

        assertEq(USDC.balanceOf(victim), 1_000e6, "the victim still has their money");
    }

    /// @dev The conversion is the reason `ReceiptKind` exists, and this is the venue that proves it
    ///      against a real market rather than a mock. Shares are fixed and the backing grows, so
    ///      after time passes the same shortfall costs **fewer** shares than it did before.
    function test_TimePassingMakesAShareWorthMore() public onlyForked {
        uint256 costBefore = venue.previewWithdraw(1_000e6);

        vm.warp(block.timestamp + 180 days);
        vm.roll(block.number + 1);

        uint256 costAfter = venue.previewWithdraw(1_000e6);

        assertLt(costAfter, costBefore, "the same USDC costs fewer shares once interest has accrued");
        assertGt(venue.totalAssets(), CAPITAL, "and the position is worth more than was put in");

        emit log_named_uint("shares for 1000 USDC, day 0  ", costBefore);
        emit log_named_uint("shares for 1000 USDC, day 180", costAfter);
        emit log_named_uint("position now                 ", venue.totalAssets());
    }

    /// @dev The number the enclave actually compares. Comet answers a per-second rate scaled by
    ///      1e18 and Aave an annual ray, and a venue that reported the wrong one would not fail —
    ///      it would win every comparison by nine orders of magnitude.
    function test_TheRateIsReportedInAavesUnitsNotComets() public onlyForked {
        ReserveData memory data = venue.getReserveData(address(USDC));

        uint256 perSecond = COMET.getSupplyRate(COMET.getUtilization());
        assertEq(
            data.currentLiquidityRate, uint128(perSecond * 365 days * 1e9), "converted, not passed through"
        );
        assertEq(data.aTokenAddress, address(venue), "and the receipt agrees with getReserveAToken");

        // A sane band rather than a fixed number: this reads a live market. Anything outside it is
        // a scaling mistake, which is the failure this test exists for.
        uint256 apyBps = uint256(data.currentLiquidityRate) / 1e23;
        assertGt(apyBps, 1, "a rate below 0.01% is a conversion that lost precision");
        assertLt(apyBps, 5000, "a rate above 50% is a conversion that gained a decimal");

        emit log_named_uint("comet per-second rate", perSecond);
        emit log_named_uint("reported ray (annual)", data.currentLiquidityRate);
        emit log_named_uint("which is, in bps     ", apyBps);
    }

    /// @dev The receipt check that blocked this in the first place, passing. Worth its own test:
    ///      it is one `require` in a deployed contract and it is the entire reason the venue is
    ///      also the token.
    function test_TheVenueAnswersTheSpellingTheDeployedAppsAskFor() public onlyForked {
        assertEq(venue.UNDERLYING_ASSET_ADDRESS(), address(USDC), "Aave's spelling, from a Compound venue");
        assertEq(
            venue.getReserveAToken(address(USDC)), address(venue), "the pool names itself as the receipt"
        );
        assertEq(COMET.baseToken(), address(USDC), "and Comet's own spelling agrees about the asset");
    }

    /// @dev What the venue can pay is bounded by both the market and this venue's own position,
    ///      and reporting either alone turns a venue that cannot pay into the answer a search
    ///      stops at.
    function test_LiquidityIsTheLowerOfTheMarketAndOurPosition() public onlyForked {
        uint256 reported = venue.getVirtualUnderlyingBalance(address(USDC));
        uint256 inMarket = USDC.balanceOf(address(COMET));
        uint256 ours = venue.totalAssets();

        assertEq(reported, inMarket < ours ? inMarket : ours, "the lower of the two");
        assertLe(reported, ours, "never more than this venue holds");
    }
}
