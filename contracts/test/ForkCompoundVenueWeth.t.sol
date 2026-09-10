// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Aqua} from "@1inch/aqua/Aqua.sol";
import {IAqua} from "@1inch/aqua/interfaces/IAqua.sol";

import {CompoundVenue, ReserveData} from "../src/CompoundVenue.sol";
import {IComet} from "../src/IComet.sol";
import {ReceiptKind} from "../src/ReceiptMath.sol";
import {HelicoMandateSwap, SwapMandate, Venue} from "../src/HelicoMandateSwap.sol";
import {PayingTaker} from "./MandateTakers.sol";

/// @notice The same venue over `cWETHv3`, so ETH earns on the way to being swapped.
///
/// @dev **Why a second file rather than a second case in the first one.** `ForkCompoundVenue.t.sol`
///      proves the design — a Compound market answering Aave's spelling, being its own receipt, and
///      paying a taker out of a wallet that holds none of the token. Repeating that proof buys
///      nothing. What this file exists for is the part the USDC market cannot test at all: the base
///      token has **eighteen** decimals instead of six, and `CompoundVenue` was written, reviewed
///      and deployed against a six-decimal market only.
///
///      A hidden `1e6` would survive every test in the other file and every deploy check, and would
///      surface as a maker being paid a millionth of what they are owed. The venue derives its own
///      decimals from the asset and never writes a scale factor down, so the expectation is that it
///      simply works — but "expected to work" and "watched working" are different claims, and the
///      submission is only allowed to make the second one.
///
///      The pair is deliberately the mirror of the USDC file: there the maker lent USDC and bought
///      WETH; here the maker lends **WETH** and sells it for USDC. So the token coming out of
///      Compound is the eighteen-decimal one, which is where a scale bug would land.
///
///      Real `cWETHv3` at `0x6f7D514b…`, on a fork of Arbitrum One. `symbol()` answers "cWETHv3",
///      `baseToken()` answers the WETH below, `decimals()` answers 18 — read from the chain, not
///      from documentation.
contract ForkCompoundVenueWethTest is Test {
    IERC20 constant USDC = IERC20(0xaf88d065e77c8cC2239327C5EDb3A432268e5831);
    IERC20 constant WETH = IERC20(0x82aF49447D8a07e3bd95BD0d56f35241523fBab1);
    IComet constant COMET = IComet(0x6f7D514bbD4aFf3BcD1140B7344b32f063dEe486);
    address constant USDC_WHALE = 0x47c031236e19d024b42f8AE6780E44A573170703;
    address constant WETH_WHALE = 0x70d95587d40A2caf56bd97485aB3Eec10Bee6336;

    Aqua aqua;
    HelicoMandateSwap app;
    CompoundVenue venue;
    PayingTaker taker;

    address maker = address(0xA11CE);
    /// @dev The witness. With a sole holder, a maker who burns too many shares hands the surplus
    ///      back to themselves and every value check nets out — so the whole suite would pass with
    ///      the share conversion removed. Somebody who did nothing must end up with what they had.
    address bystander = address(0xB0B);

    /// @dev All eighteen-decimal, which is the point of the file.
    uint256 constant CAPITAL = 20e18;
    uint256 constant BYSTANDER_CAPITAL = 5e18;
    uint256 constant RESERVE_WETH = 15e18;
    uint256 constant RESERVE_USDC = 20_000e6;
    uint256 constant FEE_BPS = 30;
    uint256 constant NO_CEILING = type(uint256).max;
    uint256 constant AMOUNT_IN = 2_000e6;

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
        expiry = uint64(block.timestamp + 365 days);

        vm.prank(WETH_WHALE);
        WETH.transfer(maker, CAPITAL);
        vm.prank(USDC_WHALE);
        USDC.transfer(maker, RESERVE_USDC);

        vm.startPrank(maker);
        // Every unit of WETH goes to work, so the wallet holds none of what the taker will be paid.
        WETH.approve(address(venue), type(uint256).max);
        venue.supply(address(WETH), CAPITAL, maker, 0);

        WETH.approve(address(aqua), type(uint256).max);
        USDC.approve(address(aqua), type(uint256).max);
        venue.approve(address(aqua), type(uint256).max);
        vm.stopPrank();

        vm.prank(WETH_WHALE);
        WETH.transfer(bystander, BYSTANDER_CAPITAL);
        vm.startPrank(bystander);
        WETH.approve(address(venue), type(uint256).max);
        venue.supply(address(WETH), BYSTANDER_CAPITAL, bystander, 0);
        vm.stopPrank();

        taker = new PayingTaker(IAqua(address(aqua)));
        vm.prank(USDC_WHALE);
        USDC.transfer(address(taker), 50_000e6);
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
        // token0 is WETH and that is the side that earns, so `receipt0` is the venue. The maker
        // never lends the USDC they hold as the other side of the pair.
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
            token0: address(WETH),
            token1: address(USDC),
            feeBps: FEE_BPS,
            maxOut0: NO_CEILING,
            maxOut1: NO_CEILING,
            expiry: expiry,
            agent: address(taker),
            salt: "compound-weth",
            venues: _venues()
        });
    }

    function _ship() internal {
        SwapMandate memory m = _mandate();
        address[] memory tokens = new address[](3);
        uint256[] memory amounts = new uint256[](3);
        tokens[0] = address(WETH);
        amounts[0] = RESERVE_WETH;
        tokens[1] = address(USDC);
        amounts[1] = RESERVE_USDC;
        tokens[2] = address(venue);
        amounts[2] = venue.balanceOf(maker);
        vm.prank(maker);
        aqua.ship(address(app), abi.encode(m), tokens, amounts);
    }

    // ── the claim ─────────────────────────────────────────────────────────────

    /// @dev The maker's wallet holds no WETH at all — every unit is inside `cWETHv3` — and a taker
    ///      who pays USDC still walks away with WETH, unwound out of Compound on the way through.
    function test_ATakerIsPaidWethOutOfCompound() public onlyForked {
        _ship();

        assertEq(WETH.balanceOf(maker), 0, "the maker's wallet holds no WETH");
        assertGt(venue.balanceOf(maker), 0, "all of it is in Compound, through this venue");

        uint256 sharesBefore = venue.balanceOf(maker);
        uint256 valueBefore = venue.previewRedeem(sharesBefore);
        uint256 bystanderBefore = venue.previewRedeem(venue.balanceOf(bystander));
        uint256 takerBefore = WETH.balanceOf(address(taker));

        uint256 out = taker.swap(app, _mandate(), false, AMOUNT_IN, 0, address(taker));

        assertGt(out, 0, "the swap paid out");
        assertEq(WETH.balanceOf(address(taker)) - takerBefore, out, "the taker was paid, on chain");
        assertLt(venue.balanceOf(maker), sharesBefore, "and the Compound position paid for it");
        assertEq(USDC.balanceOf(maker), RESERVE_USDC + AMOUNT_IN, "the maker holds the USDC they were paid");
        assertEq(WETH.balanceOf(address(app)), 0, "the app kept no WETH");
        assertEq(venue.balanceOf(address(app)), 0, "and no receipt");

        // **The assertion a wrong scale cannot satisfy.** Counting shares proves nothing on its own:
        // the app asks this venue what a shortfall costs and the venue burns what it just quoted, so
        // a bad conversion is bad in both places and cancels. Value cannot cancel — what remains in
        // the position plus what left it is what was there before.
        uint256 valueAfter = venue.previewRedeem(venue.balanceOf(maker));
        assertApproxEqAbs(
            valueAfter + out, valueBefore, 3, "the position lost exactly what the taker was paid"
        );
        assertApproxEqAbs(
            venue.previewRedeem(venue.balanceOf(bystander)), bystanderBefore, 3, "and nobody else gained"
        );

        // The sanity a decimals bug fails and the value check above cannot. That check compares the
        // venue against itself, so a conversion wrong by a constant factor satisfies it. This one
        // needs an anchor outside the venue, and the position's own size is one: the payout is a
        // real slice of twenty ETH. A factor of a million in either direction leaves that window —
        // downward it is dust, upward `withdraw` cannot find the WETH and reverts.
        //
        // The price itself is deliberately not asserted. `_quote` is constant product over the
        // committed reserves, so what a taker gets is set by the fixture's own ratio rather than by
        // the market, and pinning it would test the fixture's arithmetic instead of the venue's.
        assertGt(out, valueBefore / 100, "the payout is a real slice of the position, not dust");
        assertLt(out, valueBefore / 2, "and not more of it than a single swap could unwind");

        emit log_named_uint("paid to taker (wei)", out);
        emit log_named_uint("shares before      ", sharesBefore);
        emit log_named_uint("shares after       ", venue.balanceOf(maker));
    }

    /// @dev The same fill once a share is no longer worth exactly one wei-of-WETH. At day zero the
    ///      conversion is the identity and a broken one is indistinguishable from a working one —
    ///      which is how the Morpho suite passed with `previewWithdraw` replaced by `return assets`.
    function test_ACoverAfterTheSharePriceHasMoved() public onlyForked {
        _ship();

        vm.warp(block.timestamp + 180 days);
        vm.roll(block.number + 1);

        uint256 valueBefore = venue.previewRedeem(venue.balanceOf(maker));
        assertGt(valueBefore, CAPITAL, "the position has grown, so a share is worth more than par");

        uint256 sharesBefore = venue.balanceOf(maker);
        uint256 bystanderBefore = venue.previewRedeem(venue.balanceOf(bystander));
        uint256 out = taker.swap(app, _mandate(), false, AMOUNT_IN, 0, address(taker));
        uint256 burned = sharesBefore - venue.balanceOf(maker);

        assertLt(burned, out, "fewer shares than wei, because a share now redeems for more");

        uint256 valueAfter = venue.previewRedeem(venue.balanceOf(maker));
        assertApproxEqAbs(valueAfter + out, valueBefore, 3, "and the position lost exactly what left it");
        assertApproxEqAbs(
            venue.previewRedeem(venue.balanceOf(bystander)), bystanderBefore, 3, "and nobody else gained"
        );

        emit log_named_uint("position before", valueBefore);
        emit log_named_uint("paid to taker  ", out);
        emit log_named_uint("shares burned  ", burned);
    }

    // ── the eighteen-decimal reading ──────────────────────────────────────────

    /// @dev Not cosmetic. `decimals` is derived from the asset rather than fixed, and a venue that
    ///      answered six over an eighteen-decimal market would make every hand-checked figure in a
    ///      test wrong by a factor of a million while still compiling and still passing.
    function test_TheReceiptCountsInTheAssetsOwnUnits() public onlyForked {
        assertEq(venue.decimals(), 18, "the receipt counts in WETH's units");
        assertEq(venue.decimals(), IERC20Metadata(address(WETH)).decimals(), "which is the asset's");
        assertEq(venue.symbol(), "hcWETH", "and it names the market it came from");
        assertEq(venue.name(), "Helico Compound WETH");
        assertEq(venue.ASSET(), address(WETH));
    }

    /// @dev A round trip at eighteen decimals. `previewWithdraw` rounds up and the virtual offset
    ///      costs a wei, both deliberately against the depositor, so the loss is bounded rather than
    ///      zero — but it is bounded in **wei**, and a scale error would blow that bound apart.
    function test_ADepositCanBeWithdrawnWhole() public onlyForked {
        address alice = address(0xA71CE);
        vm.prank(WETH_WHALE);
        WETH.transfer(alice, 3e18);

        vm.startPrank(alice);
        WETH.approve(address(venue), type(uint256).max);
        venue.supply(address(WETH), 3e18, alice, 0);
        uint256 shares = venue.balanceOf(alice);
        assertGt(shares, 0, "the deposit minted shares");

        uint256 redeemable = venue.previewRedeem(shares);
        venue.withdraw(address(WETH), redeemable, alice);
        vm.stopPrank();

        assertApproxEqAbs(WETH.balanceOf(alice), 3e18, 3, "three ETH in, three ETH back out");
    }

    /// @dev Compound answers a per-second rate scaled 1e18; Aave reports an annual ray. The venue
    ///      does both conversions so the enclave never learns which protocol answered — and the
    ///      arithmetic is the same at eighteen decimals as at six, which is worth watching once.
    function test_TheRateIsReportedInAavesUnitsNotComets() public onlyForked {
        uint256 perSecond = COMET.getSupplyRate(COMET.getUtilization());
        uint256 ray = venue.getReserveData(address(WETH)).currentLiquidityRate;

        assertEq(ray, perSecond * 365 days * 1e9, "annual, in ray, from per-second in wad");
        // A live WETH market pays something, and pays less than a hundred percent. Both ends
        // matter: a missing `1e9` lands far below the floor and a doubled one far above the ceiling.
        assertGt(ray, 1e23, "at least a basis point");
        assertLt(ray, 1e27, "and under a hundred percent");

        emit log_named_uint("cWETHv3 bps", ray / 1e23);
    }

    /// @dev The venue names itself as its own receipt, and answers the spelling the deployed apps
    ///      ask for. Both halves of the trick, at a market that is not the one it was written for.
    function test_TheVenueAnswersTheSpellingTheDeployedAppsAskFor() public onlyForked {
        assertEq(venue.UNDERLYING_ASSET_ADDRESS(), address(WETH), "Aave's spelling, from a Comet market");
        assertEq(venue.getReserveAToken(address(WETH)), address(venue), "and it is its own receipt");
        assertEq(venue.getReserveData(address(WETH)).aTokenAddress, address(venue), "consistently");
    }

    /// @dev Liquidity is the lower of what the market holds and what this venue's position is
    ///      worth. Reporting either alone turns a venue that cannot pay into the answer a cover
    ///      search stops at.
    function test_LiquidityIsTheLowerOfTheMarketAndOurPosition() public onlyForked {
        uint256 inMarket = WETH.balanceOf(address(COMET));
        uint256 ours = venue.totalAssets();
        assertEq(
            venue.getVirtualUnderlyingBalance(address(WETH)),
            inMarket < ours ? inMarket : ours,
            "the binding ceiling, not the flattering one"
        );
        // Here it is our own position that binds: twenty-five ETH against a market holding
        // hundreds. The assertion above would pass either way, so say which case was exercised.
        assertLt(ours, inMarket, "the venue's position is the smaller of the two today");
    }
}
