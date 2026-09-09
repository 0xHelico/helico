// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {HelicoAccount} from "../src/HelicoAccount.sol";
import {HelicoAccountFactory} from "../src/HelicoAccountFactory.sol";
import {ILendingVenue} from "../src/ILendingVenue.sol";
import {CompoundVenue, ReserveData} from "../src/CompoundVenue.sol";
import {MorphoVenue} from "../src/MorphoVenue.sol";
import {IComet} from "../src/IComet.sol";
import {IERC4626Vault} from "../src/IERC4626Vault.sol";

interface IAaveReserves {
    function getReserveData(address asset) external view returns (ReserveData memory);
}

/// @notice The claim the whole venue exercise was for: an agent comparing **three protocols** and
///         moving capital to the best of them.
///
/// @dev Ghoza's argument, and the reason `CompoundVenue` and `MorphoVenue` exist at all:
///      *"fungsinya cre buat yield optimizer jadi apa kalau komparasinya hanya satu protocol."*
///      An optimiser that ranks markets inside one protocol family is a market picker.
///
///      Both venue files were proven on the **cover** side first — a taker paid out of a position
///      that was still earning. This file is the other half and the one that was missing: the
///      **yield** side, `HelicoAccount.supplyIdle` and `withdrawIdle`, which is what the enclave
///      actually drives every five minutes.
///
///      Nothing here is mocked. Aave v3, Compound v3 and a Steakhouse MetaMorpho vault, all live
///      on a fork of Arbitrum One, reached through one deployed account that knows about none of
///      them by name.
contract ForkThreeProtocolYieldTest is Test {
    IERC20 constant USDC = IERC20(0xaf88d065e77c8cC2239327C5EDb3A432268e5831);
    IERC20 constant AUSDC = IERC20(0x724dc807b04555b71ed48a6896b6F41593b8C637);
    address constant AAVE_POOL = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;
    IComet constant COMET = IComet(0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf);
    IERC4626Vault constant MORPHO_VAULT = IERC4626Vault(0x5c0C306Aaa9F877de636f4d5822cA9F2E81563BA);
    address constant USDC_WHALE = 0x47c031236e19d024b42f8AE6780E44A573170703;

    HelicoAccountFactory factory;
    CompoundVenue compound;
    MorphoVenue morpho;

    address owner = makeAddr("owner");
    address agent = makeAddr("agent");
    address account;

    uint256 constant FUNDED = 30_000e6;
    uint256 constant PARK = 9_000e6;

    bool forked;

    function setUp() public {
        try vm.createSelectFork("arbitrum") {
            forked = true;
        } catch {
            forked = false;
            return;
        }

        factory = new HelicoAccountFactory(address(new HelicoAccount(address(0))));
        compound = new CompoundVenue(COMET);
        morpho = new MorphoVenue(MORPHO_VAULT);

        account = factory.open(owner);
        vm.prank(USDC_WHALE);
        USDC.transfer(account, FUNDED);

        vm.startPrank(owner);
        HelicoAccount(payable(account)).setAgent(agent);
        // Three protocols, named by the owner and by nobody else. The account has no idea which
        // is which; each is an address that answers `ILendingVenue`.
        HelicoAccount(payable(account)).permitVenue(AAVE_POOL, true);
        HelicoAccount(payable(account)).permitVenue(address(compound), true);
        HelicoAccount(payable(account)).permitVenue(address(morpho), true);
        vm.stopPrank();
    }

    modifier onlyForked() {
        if (!forked) {
            emit log("SKIP: no `arbitrum` RPC endpoint configured");
            return;
        }
        _;
    }

    // ── the claim ─────────────────────────────────────────────────────────────

    /// @dev One account, three protocols, one caller. The agent is the enclave's key and it never
    ///      learns what any of these venues are.
    function test_TheAgentCanParkCapitalInAllThreeProtocols() public onlyForked {
        vm.startPrank(agent);
        HelicoAccount(payable(account)).supplyIdle(AAVE_POOL, address(USDC), PARK);
        HelicoAccount(payable(account)).supplyIdle(address(compound), address(USDC), PARK);
        HelicoAccount(payable(account)).supplyIdle(address(morpho), address(USDC), PARK);
        vm.stopPrank();

        assertApproxEqAbs(AUSDC.balanceOf(account), PARK, 1, "Aave holds a third");
        assertApproxEqAbs(compound.previewRedeem(compound.balanceOf(account)), PARK, 2, "Compound a third");
        assertApproxEqAbs(morpho.previewRedeem(morpho.balanceOf(account)), PARK, 2, "Morpho a third");
        assertEq(USDC.balanceOf(account), FUNDED - 3 * PARK, "and the wallet holds the remainder");

        emit log_named_uint("in aave    ", AUSDC.balanceOf(account));
        emit log_named_uint("in compound", compound.previewRedeem(compound.balanceOf(account)));
        emit log_named_uint("in morpho  ", morpho.previewRedeem(morpho.balanceOf(account)));
    }

    /// @dev The move the enclave exists to make, and the one it could not make before: capital
    ///      leaving one protocol and arriving in another, in one agent's transaction pair.
    function test_TheAgentCanMoveCapitalBetweenProtocols() public onlyForked {
        vm.prank(agent);
        HelicoAccount(payable(account)).supplyIdle(AAVE_POOL, address(USDC), PARK);
        assertApproxEqAbs(AUSDC.balanceOf(account), PARK, 1, "it starts in Aave");

        // The receipt balance, not the amount supplied. See the test below for why those are two
        // different numbers, and why sizing a move from the second one is how a mover strands
        // capital it believes it has already emptied.
        uint256 inAave = AUSDC.balanceOf(account);

        vm.startPrank(agent);
        HelicoAccount(payable(account)).withdrawIdle(AAVE_POOL, address(USDC), inAave);
        HelicoAccount(payable(account)).supplyIdle(address(morpho), address(USDC), inAave);
        vm.stopPrank();

        assertLt(AUSDC.balanceOf(account), 2, "Aave is empty but for dust");
        assertApproxEqAbs(morpho.previewRedeem(morpho.balanceOf(account)), inAave, 2, "and Morpho holds it");
        assertApproxEqAbs(USDC.balanceOf(account), FUNDED - PARK, 2, "nothing was left loose on the way");

        emit log_named_uint("supplied to aave", PARK);
        emit log_named_uint("aToken balance  ", inAave);
        emit log_named_uint("landed in morpho", morpho.previewRedeem(morpho.balanceOf(account)));
    }

    /// @dev Found by this suite failing rather than reasoned about, and worth keeping: **you cannot
    ///      withdraw from Aave exactly what you supplied to it.** Supplying 9,000 USDC leaves
    ///      8,999,999,999 aUSDC — one unit short, from the liquidity index rounding down — and
    ///      asking for the round number back reverts with Aave's own
    ///      `NotEnoughAvailableUserBalance()`.
    ///
    ///      This matters beyond the fixture. A mover that sizes a withdrawal from *what it supplied*
    ///      rather than from *the receipt it holds* fails on the first full exit of a position it
    ///      opened itself, and fails with an error that names neither the venue nor the amount.
    function test_WithdrawingExactlyWhatWasSuppliedIsRefusedByAave() public onlyForked {
        vm.prank(agent);
        HelicoAccount(payable(account)).supplyIdle(AAVE_POOL, address(USDC), PARK);

        assertEq(AUSDC.balanceOf(account), PARK - 1, "one unit short, and this is the whole point");

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSignature("NotEnoughAvailableUserBalance()"));
        HelicoAccount(payable(account)).withdrawIdle(AAVE_POOL, address(USDC), PARK);

        // The receipt balance works, which is what the mover should be reading. Read into a local
        // **before** the prank: an external call in the argument list is evaluated first and eats
        // the prank, so the withdrawal would arrive from this test contract and fail as
        // `NotOwnerOrAgent` — which is what the first version of this line did.
        uint256 held = AUSDC.balanceOf(account);
        vm.prank(agent);
        HelicoAccount(payable(account)).withdrawIdle(AAVE_POOL, address(USDC), held);
        assertLt(AUSDC.balanceOf(account), 2, "and the position is closed");
    }

    /// @dev **The test the whole exercise is for.** Three protocols, three completely different
    ///      rate sources, one unit — because a decision that compares them has to.
    ///
    ///      Aave publishes `currentLiquidityRate` as an annual ray. Comet publishes a per-second
    ///      rate scaled by 1e18. A MetaMorpho vault publishes nothing at all and its venue measures
    ///      the share price instead. If any of the three conversions were wrong, that venue would
    ///      not merely be mispriced — it would win or lose every comparison by orders of magnitude.
    function test_TheThreeProtocolsQuoteRatesInOneComparableUnit() public onlyForked {
        // Morpho's is trailing, so it needs a window before it can say anything.
        vm.warp(block.timestamp + 30 days);
        vm.roll(block.number + 1);
        morpho.poke();

        uint256 aave = IAaveReserves(AAVE_POOL).getReserveData(address(USDC)).currentLiquidityRate;
        uint256 comp = compound.getReserveData(address(USDC)).currentLiquidityRate;
        uint256 morph = morpho.getReserveData(address(USDC)).currentLiquidityRate;

        // A band, not a number: these read live markets. What is being caught is a scaling
        // mistake, which is orders of magnitude rather than basis points.
        for (uint256 i = 0; i < 3; i++) {
            uint256 ray = i == 0 ? aave : i == 1 ? comp : morph;
            uint256 bps = ray / 1e23;
            assertGt(bps, 1, "a rate below 0.01% is a conversion that lost precision");
            assertLt(bps, 5000, "a rate above 50% is a conversion that gained a decimal");
        }

        emit log_named_uint("aave     bps", aave / 1e23);
        emit log_named_uint("compound bps", comp / 1e23);
        emit log_named_uint("morpho   bps", morph / 1e23);
        emit log_named_uint(
            "best is (0=aave 1=comp 2=morpho)", aave >= comp && aave >= morph ? 0 : comp >= morph ? 1 : 2
        );
    }

    /// @dev The bound that makes an agent harmless. A venue the owner never named is refused even
    ///      though it answers the interface perfectly — this one is a real, working Compound venue.
    function test_AVenueTheOwnerNeverNamedIsRefused() public onlyForked {
        CompoundVenue stranger = new CompoundVenue(COMET);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(HelicoAccount.VenueNotPermitted.selector, address(stranger)));
        HelicoAccount(payable(account)).supplyIdle(address(stranger), address(USDC), PARK);
    }

    /// @dev Revoking closes the way in, not the way out. An owner who changes their mind about
    ///      Morpho must not thereby strand the capital already in it.
    function test_RevokingAVenueStillLetsTheAgentUnwindIt() public onlyForked {
        vm.prank(agent);
        HelicoAccount(payable(account)).supplyIdle(address(morpho), address(USDC), PARK);

        vm.prank(owner);
        HelicoAccount(payable(account)).permitVenue(address(morpho), false);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(HelicoAccount.VenueNotPermitted.selector, address(morpho)));
        HelicoAccount(payable(account)).supplyIdle(address(morpho), address(USDC), 100e6);

        vm.prank(agent);
        HelicoAccount(payable(account)).withdrawIdle(address(morpho), address(USDC), PARK - 2);
        assertGe(USDC.balanceOf(account), FUNDED - PARK, "the capital came home");
    }
}
