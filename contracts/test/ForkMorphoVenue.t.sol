// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Aqua} from "@1inch/aqua/Aqua.sol";
import {IAqua} from "@1inch/aqua/interfaces/IAqua.sol";

import {ReserveData} from "../src/CompoundVenue.sol";
import {MorphoVenue} from "../src/MorphoVenue.sol";
import {IERC4626Vault} from "../src/IERC4626Vault.sol";
import {ReceiptKind} from "../src/ReceiptMath.sol";
import {HelicoMandateSwap, SwapMandate, Venue} from "../src/HelicoMandateSwap.sol";
import {PayingTaker} from "./MandateTakers.sol";

/// @notice A maker paid out of Morpho, through an app that only knew how to read Aave.
///
/// @dev The second protocol, and the one that made the rate question real. Aave publishes
///      `currentLiquidityRate` and Comet publishes `getSupplyRate`; a MetaMorpho vault publishes
///      **nothing** — the APY on Morpho's own front end comes from their API. So this venue
///      measures the share price instead, and these tests are mostly about whether that
///      measurement is worth anything.
///
///      Real vault, real USDC, real WETH, on a fork of Arbitrum One:
///
///          vault    0x5c0C306Aaa9F877de636f4d5822cA9F2E81563BA   bbqUSDC, Steakhouse
///          asset()  0xaf88d065e77c8cC2239327C5EDb3A432268e5831   native USDC
///          MORPHO() 0x6c247b1F6182318877311737BaC0844bAa518F5e   Morpho Blue
contract ForkMorphoVenueTest is Test {
    IERC20 constant USDC = IERC20(0xaf88d065e77c8cC2239327C5EDb3A432268e5831);
    IERC20 constant WETH = IERC20(0x82aF49447D8a07e3bd95BD0d56f35241523fBab1);
    IERC4626Vault constant VAULT = IERC4626Vault(0x5c0C306Aaa9F877de636f4d5822cA9F2E81563BA);
    address constant USDC_WHALE = 0x47c031236e19d024b42f8AE6780E44A573170703;
    address constant WETH_WHALE = 0x70d95587d40A2caf56bd97485aB3Eec10Bee6336;

    Aqua aqua;
    HelicoMandateSwap app;
    MorphoVenue venue;
    PayingTaker taker;

    address maker = address(0xA11CE);
    /// @dev The witness. With one holder, over-burning hands the surplus back to that same holder
    ///      and every value check passes with the conversion removed — the trap #296 recorded and
    ///      `ForkCompoundVenue` found again.
    address bystander = address(0xB0B);

    uint256 constant CAPITAL = 20_000e6;
    uint256 constant BYSTANDER_CAPITAL = 5_000e6;
    uint256 constant RESERVE_USDC = 18_000e6;
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
        app = new HelicoMandateSwap(IAqua(address(aqua)));
        venue = new MorphoVenue(VAULT);
        expiry = uint64(block.timestamp + 365 days);

        vm.prank(USDC_WHALE);
        USDC.transfer(maker, CAPITAL);
        vm.prank(WETH_WHALE);
        WETH.transfer(maker, RESERVE_WETH);

        vm.startPrank(maker);
        USDC.approve(address(venue), type(uint256).max);
        venue.supply(address(USDC), CAPITAL, maker, 0);
        USDC.approve(address(aqua), type(uint256).max);
        WETH.approve(address(aqua), type(uint256).max);
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
            salt: "morpho",
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

    /// @dev A taker paid out of a Morpho vault, from a maker whose wallet holds no USDC.
    function test_ATakerIsPaidOutOfMorpho() public onlyForked {
        _ship();

        assertEq(USDC.balanceOf(maker), 0, "the maker's wallet holds no USDC");
        assertGt(venue.balanceOf(maker), 0, "all of it is in the Morpho vault, through this venue");

        uint256 sharesBefore = venue.balanceOf(maker);
        uint256 valueBefore = venue.previewRedeem(sharesBefore);
        uint256 bystanderBefore = venue.previewRedeem(venue.balanceOf(bystander));
        uint256 takerBefore = USDC.balanceOf(address(taker));

        uint256 out = taker.swap(app, _mandate(), false, AMOUNT_IN, 0, address(taker));

        assertGt(out, 0, "the swap paid out");
        assertEq(USDC.balanceOf(address(taker)) - takerBefore, out, "the taker was paid, on chain");
        assertLt(venue.balanceOf(maker), sharesBefore, "and the Morpho position paid for it");
        assertEq(WETH.balanceOf(maker), RESERVE_WETH + AMOUNT_IN, "the maker holds the WETH they bought");
        assertEq(venue.balanceOf(address(app)), 0, "the app kept no receipt");
        assertEq(USDC.balanceOf(address(app)), 0, "and no USDC");

        assertApproxEqAbs(
            venue.previewRedeem(venue.balanceOf(maker)) + out,
            valueBefore,
            3,
            "the position lost what left it"
        );
        assertApproxEqAbs(
            venue.previewRedeem(venue.balanceOf(bystander)), bystanderBefore, 3, "and nobody else gained"
        );

        emit log_named_uint("paid to taker (USDC)", out);
        emit log_named_uint("shares before       ", sharesBefore);
        emit log_named_uint("shares after        ", venue.balanceOf(maker));
    }

    /// @dev The same fill, after the share price has moved off par — and the test the Compound
    ///      suite had and this one did not. At deposit a share of this venue is worth exactly one
    ///      USDC, so a conversion that does nothing is *correct* at that moment and a mutation
    ///      removing it passes every assertion above. Verified: `previewWithdraw → return assets`
    ///      left all seven green until this test existed.
    ///
    ///      Once interest has accrued the two numbers genuinely differ, and both the shape check
    ///      and the value check bite.
    function test_ACoverAfterTheSharePriceHasMoved() public onlyForked {
        _ship();

        vm.warp(block.timestamp + 90 days);
        vm.roll(block.number + 1);

        uint256 sharesBefore = venue.balanceOf(maker);
        uint256 valueBefore = venue.previewRedeem(sharesBefore);
        uint256 bystanderBefore = venue.previewRedeem(venue.balanceOf(bystander));
        assertGt(valueBefore, CAPITAL, "the position has grown, so a share is no longer one USDC");

        uint256 out = taker.swap(app, _mandate(), false, AMOUNT_IN, 0, address(taker));
        uint256 burned = sharesBefore - venue.balanceOf(maker);

        assertLt(burned, out, "fewer shares than USDC, because a share is now worth more than one");
        assertApproxEqAbs(
            venue.previewRedeem(venue.balanceOf(maker)) + out,
            valueBefore,
            3,
            "the position lost what left it"
        );
        assertApproxEqAbs(
            venue.previewRedeem(venue.balanceOf(bystander)), bystanderBefore, 3, "and nobody else gained"
        );

        emit log_named_uint("position before", valueBefore);
        emit log_named_uint("paid to taker  ", out);
        emit log_named_uint("shares burned  ", burned);
        emit log_named_uint("what 1:1 burns ", out);
    }

    /// @dev The same hole as `ForkCompoundVenue`, in the venue that shares its share maths. Here
    ///      the donation is an ordinary ERC-4626 deposit crediting the venue, which needs no
    ///      special interface at all.
    function test_ADepositThatWouldMintNothingIsRefused() public onlyForked {
        address attacker = address(0xBAD);
        address victim = address(0x71C);

        vm.prank(USDC_WHALE);
        USDC.transfer(attacker, 30_000e6 + 1);
        vm.prank(USDC_WHALE);
        USDC.transfer(victim, 1_000e6);

        // Fresh, because the attack needs a first depositor and the venue in `setUp` is funded.
        MorphoVenue empty = new MorphoVenue(VAULT);

        vm.startPrank(attacker);
        USDC.approve(address(empty), type(uint256).max);
        empty.supply(address(USDC), 1, attacker, 0);
        USDC.approve(address(VAULT), type(uint256).max);
        VAULT.deposit(30_000e6, address(empty));
        vm.stopPrank();

        assertGt(empty.totalAssets(), 29_000e6, "the pool holds far more than its shares");

        vm.startPrank(victim);
        USDC.approve(address(empty), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(MorphoVenue.DepositMintsNothing.selector, 1_000e6));
        empty.supply(address(USDC), 1_000e6, victim, 0);
        vm.stopPrank();

        assertEq(USDC.balanceOf(victim), 1_000e6, "the victim still has their money");
    }

    // ── the rate, which is the part Morpho makes hard ─────────────────────────

    /// @dev Morpho publishes no rate, so this venue measures one. The assertion is a band rather
    ///      than a number: it reads a live vault whose yield moves, and the failures worth catching
    ///      are scale mistakes, which are orders of magnitude rather than basis points.
    function test_TheRateIsMeasuredRatherThanModelled() public onlyForked {
        assertEq(venue.sampledRateRay(), 0, "nothing is claimed before a window has passed");

        vm.warp(block.timestamp + 30 days);
        vm.roll(block.number + 1);
        venue.poke();

        uint256 rate = venue.sampledRateRay();
        uint256 apyBps = rate / 1e23;

        assertGt(apyBps, 1, "a rate below 0.01% is a conversion that lost precision");
        assertLt(apyBps, 5000, "a rate above 50% is a conversion that gained a decimal");
        assertEq(venue.sampledAt(), uint40(block.timestamp), "and the observation is dated");

        emit log_named_uint("trailing realised ray", rate);
        emit log_named_uint("which is, in bps     ", apyBps);
    }

    /// @dev The probe size is load-bearing and this is the test that says so.
    ///
    ///      The first version of this test claimed ten minutes was *invisible* at `1e18` and was
    ///      wrong — it moves by one unit. One unit is the point rather than zero: a rate computed
    ///      from a one-unit delta is quantised to whole percent-scale steps, so it is not that the
    ///      small probe reports nothing, it is that everything it reports is rounding.
    ///
    ///      The claim that holds is the ratio. At `1e18` ten minutes of this vault's yield moves
    ///      the price by a couple of integer units; at `1e27` it moves it by hundreds of millions,
    ///      which is nine more digits of signal for the same observation.
    function test_TheProbeIsLargeEnoughToSeeAShortWindow() public onlyForked {
        uint256 coarse = VAULT.convertToAssets(1e18);
        uint256 fine = VAULT.convertToAssets(1e27);

        vm.warp(block.timestamp + 10 minutes);
        vm.roll(block.number + 1);

        uint256 coarseDelta = VAULT.convertToAssets(1e18) - coarse;
        uint256 fineDelta = VAULT.convertToAssets(1e27) - fine;

        assertLe(coarseDelta, 2, "at the small probe ten minutes is a rounding step");
        assertGt(fineDelta, 1e6, "at the large one it is a measurement");
        assertGt(fineDelta / (coarseDelta + 1), 1e6, "six orders of magnitude more signal, at least");

        venue.poke();
        assertGt(venue.sampledRateRay(), 0, "so ten minutes is enough to report a rate");

        emit log_named_uint("ten minutes at probe 1e18", coarseDelta);
        emit log_named_uint("ten minutes at probe 1e27", fineDelta);
    }

    /// @dev A window shorter than a minute is not annualised. One block's rounding turned into a
    ///      yearly figure is a number the enclave would act on.
    function test_AWindowTooShortIsNotAnnualised() public onlyForked {
        uint40 was = venue.sampledAt();
        vm.warp(block.timestamp + 30);
        venue.poke();
        assertEq(venue.sampledAt(), was, "the observation was not replaced");
        assertEq(venue.sampledRateRay(), 0, "and nothing was claimed");
    }

    // ── the rest of the interface ─────────────────────────────────────────────

    function test_TheVenueAnswersTheSpellingTheDeployedAppsAskFor() public onlyForked {
        assertEq(venue.UNDERLYING_ASSET_ADDRESS(), address(USDC), "Aave's spelling, from a Morpho venue");
        assertEq(
            venue.getReserveAToken(address(USDC)), address(venue), "the pool names itself as the receipt"
        );
        assertEq(VAULT.asset(), address(USDC), "and the vault's own spelling agrees about the asset");

        ReserveData memory data = venue.getReserveData(address(USDC));
        assertEq(data.aTokenAddress, address(venue), "the reserve tuple agrees with getReserveAToken");
    }

    /// @dev What the vault *holds* and what it will *pay* are different numbers, and only one of
    ///      them is the ceiling. This vault held ten thousand wei of USDC against 2.4M supplied.
    function test_LiquidityIsWhatTheVaultWillPayNotWhatItHolds() public onlyForked {
        uint256 idle = USDC.balanceOf(address(VAULT));
        uint256 reported = venue.getVirtualUnderlyingBalance(address(USDC));

        assertGt(reported, idle, "a balance read would have refused a venue that can pay");
        assertLe(reported, venue.totalAssets(), "and never more than this venue holds");

        emit log_named_uint("USDC idle in the vault", idle);
        emit log_named_uint("what it will pay us   ", reported);
    }

    /// @dev The decimals mismatch this venue exists to absorb: the vault counts in eighteen and the
    ///      asset in six, and a venue that passed amounts through would be wrong by 1e12.
    function test_TheVenueCountsInTheAssetsUnitsNotTheVaults() public onlyForked {
        assertEq(venue.decimals(), 6, "this venue counts in USDC");
        assertEq(IERC20Decimals(address(VAULT)).decimals(), 18, "the vault counts in its own shares");
        assertApproxEqRel(
            venue.previewRedeem(venue.balanceOf(maker)), CAPITAL, 0.001e18, "and a share is a USDC"
        );
    }
}

interface IERC20Decimals {
    function decimals() external view returns (uint8);
}
