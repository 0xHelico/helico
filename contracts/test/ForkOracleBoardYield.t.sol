// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Aqua} from "@1inch/aqua/Aqua.sol";
import {IAqua} from "@1inch/aqua/interfaces/IAqua.sol";

import {HelicoOracleBoard, IHelicoOracleBoardCallback, IPriceFeed} from "../src/HelicoOracleBoard.sol";
import {Venue} from "../src/HelicoMandateSwap.sol";
import {ReceiptKind} from "../src/ReceiptMath.sol";
import {ILendingVenue} from "../src/ILendingVenue.sol";

/// @notice `borrow` is deliberately absent from `ILendingVenue` — the app never borrows, and an
///         interface that can do more than the code does is a promise nobody keeps. The test
///         needs it to create the state the app must refuse, so it declares its own.
interface IAaveBorrow {
    function borrow(address asset, uint256 amount, uint256 rateMode, uint16 referral, address onBehalfOf)
        external;
}

/// @notice The three properties, together: one token, a live price, and the capital in Aave.
///
/// @dev Each half was already proven and the combination was not, which is a different thing and
///      was briefly claimed as though it were the same. `ForkSwapVMYieldCover` settles out of a
///      lending position but through the constant-product app, which needs both sides of a pair.
///      `ForkOracleBoard` quotes a one-sided maker from Chainlink but has no venues, so it pulls
///      from the wallet and a maker whose wallet is empty is quoted a price nobody can be paid.
///
///      Here the maker holds **no loose USDC at all** — every unit of it is supplied to Aave v3 —
///      and a taker still gets paid, because the fill unwinds exactly the shortfall on the way
///      through. That sentence is the product, and until this file it had never run.
contract ForkOracleBoardYieldTest is Test, IHelicoOracleBoardCallback {
    IERC20 constant USDC = IERC20(0xaf88d065e77c8cC2239327C5EDb3A432268e5831);
    IERC20 constant AUSDC = IERC20(0x724dc807b04555b71ed48a6896b6F41593b8C637);
    IERC20 constant WETH = IERC20(0x82aF49447D8a07e3bd95BD0d56f35241523fBab1);
    ILendingVenue constant POOL = ILendingVenue(0x794a61358D6845594F94dc1DB02A252b5b4814aD);
    IPriceFeed constant FEED = IPriceFeed(0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612);
    address constant USDC_WHALE = 0x47c031236e19d024b42f8AE6780E44A573170703;
    address constant WETH_WHALE = 0x70d95587d40A2caf56bd97485aB3Eec10Bee6336;

    Aqua aqua;
    HelicoOracleBoard board;
    address maker = address(0xA11CE);

    uint256 constant CAPITAL = 30_000e6;
    uint256 constant LOOSE = 500e6; // deliberately far less than a fill needs
    uint256 constant SPREAD_BPS = 30;
    uint256 constant MAX_SKEW_BPS = 200;
    uint256 constant BASE_CAP = 6e18;

    bool forked;
    uint256 expiry;

    function setUp() public {
        try vm.createSelectFork("arbitrum") {
            forked = true;
        } catch {
            forked = false;
            return;
        }
        aqua = new Aqua();
        board = new HelicoOracleBoard(IAqua(address(aqua)), address(0));
        expiry = block.timestamp + 30 days;

        vm.prank(USDC_WHALE);
        USDC.transfer(maker, CAPITAL);

        vm.startPrank(maker);
        // Everything but a token float goes to work. This is the position the product describes.
        USDC.approve(address(POOL), type(uint256).max);
        POOL.supply(address(USDC), CAPITAL - LOOSE, maker, 0);
        USDC.approve(address(aqua), type(uint256).max);
        WETH.approve(address(aqua), type(uint256).max);
        // The receipt is pulled through Aqua like any other token, so Aqua needs the allowance —
        // and the budget stays a number the maker shipped rather than an open approval to us.
        AUSDC.approve(address(aqua), type(uint256).max);
        vm.stopPrank();

        vm.prank(WETH_WHALE);
        WETH.transfer(address(this), 20e18);
        WETH.approve(address(aqua), type(uint256).max);
        USDC.approve(address(aqua), type(uint256).max);
    }

    modifier onlyForked() {
        if (!forked) {
            emit log("SKIP: no `arbitrum` RPC endpoint configured");
            return;
        }
        _;
    }

    function _venues() internal pure returns (Venue[] memory v) {
        v = new Venue[](1);
        // receipt0 is the receipt for `quote` (aUSDC); receipt1 for `base`, and there is none —
        // this maker never intends to lend the ETH they buy.
        v[0] = Venue({
            pool: address(POOL), receipt0: address(AUSDC), receipt1: address(0), kind: ReceiptKind.Rebasing
        });
    }

    function _board() internal view returns (HelicoOracleBoard.Board memory) {
        return HelicoOracleBoard.Board({
            maker: maker,
            quote: address(USDC),
            base: address(WETH),
            feed: address(FEED),
            maxStaleness: 1 hours,
            spreadBps: SPREAD_BPS,
            maxSkewBps: MAX_SKEW_BPS,
            baseCap: BASE_CAP,
            expiry: expiry,
            venues: _venues(),
            app: address(board),
            salt: bytes32(uint256(7))
        });
    }

    function helicoOracleBoardCallback(address tokenIn, uint256 amountIn, address maker_, bytes32 hash)
        external
    {
        aqua.push(maker_, address(board), hash, tokenIn, amountIn);
    }

    /// @dev Three tokens are named: the pair, and the receipt that funds the unwind. The receipt's
    ///      amount is the budget this board may ever redeem, and `dock` destroys it.
    function _ship(uint256 receiptBudget) internal {
        address[] memory tokens = new address[](3);
        uint256[] memory amounts = new uint256[](3);
        tokens[0] = address(USDC);
        amounts[0] = CAPITAL;
        tokens[1] = address(WETH);
        amounts[1] = 0;
        tokens[2] = address(AUSDC);
        amounts[2] = receiptBudget;
        vm.prank(maker);
        aqua.ship(address(board), abi.encode(_board()), tokens, amounts);
    }

    // ── the claim ─────────────────────────────────────────────────────────────

    /// @dev The whole thing, in one comparison: the fill paid out more than the maker's wallet
    ///      held, and the lending position is what covered the difference.
    function test_AOneSidedMakerIsPaidOutOfCapitalStillEarning() public onlyForked {
        _ship(CAPITAL);

        uint256 looseBefore = USDC.balanceOf(maker);
        uint256 suppliedBefore = AUSDC.balanceOf(maker);
        assertEq(looseBefore, LOOSE, "the wallet holds a float and nothing more");
        assertGt(suppliedBefore, 20_000e6, "and the rest is earning");
        assertEq(WETH.balanceOf(maker), 0, "the maker holds no ETH: this is a one-sided board");

        uint256 amountIn = 1e18;
        uint256 expected = board.quoteExactIn(_board(), true, amountIn);
        assertGt(expected, looseBefore, "the fill is deliberately larger than the wallet");

        uint256 takerBefore = USDC.balanceOf(address(this));
        uint256 amountOut = board.fill(_board(), true, amountIn, 0, address(this));

        assertEq(amountOut, expected, "paid at the quoted price");
        assertEq(USDC.balanceOf(address(this)) - takerBefore, amountOut, "the taker was paid, on chain");
        assertLt(AUSDC.balanceOf(maker), suppliedBefore, "and the lending position paid for it");
        assertEq(WETH.balanceOf(maker), amountIn, "the maker holds the ETH they bought");
        assertEq(USDC.balanceOf(address(board)), 0, "the app kept no USDC");
        assertEq(AUSDC.balanceOf(address(board)), 0, "and no receipt");

        emit log_named_uint("loose before    ", looseBefore);
        emit log_named_uint("supplied before ", suppliedBefore);
        emit log_named_uint("paid to taker   ", amountOut);
        emit log_named_uint("supplied after  ", AUSDC.balanceOf(maker));
        emit log_named_uint("loose after     ", USDC.balanceOf(maker));
    }

    /// @dev The wallet is spent first, always. A fill the float already covers must not touch the
    ///      market at all — otherwise a paused or illiquid Aave breaks fills that never needed it.
    function test_AFillTheWalletCoversDoesNotTouchTheMarket() public onlyForked {
        _ship(CAPITAL);

        uint256 suppliedBefore = AUSDC.balanceOf(maker);
        // Small enough that the float covers it outright.
        uint256 tiny = 1e14;
        uint256 out = board.fill(_board(), true, tiny, 0, address(this));

        assertLt(out, LOOSE, "the fill is inside the float");
        assertEq(AUSDC.balanceOf(maker), suppliedBefore, "the position was not touched");
    }

    /// @dev The receipt amount shipped is a budget, not a formality. Past it the board refuses
    ///      rather than redeeming a position the maker never offered to this board.
    function test_TheReceiptBudgetBoundsWhatCanBeUnwound() public onlyForked {
        _ship(100e6); // a hundred USDC of receipt, against a fill needing thousands

        vm.expectRevert(
            abi.encodeWithSelector(
                HelicoOracleBoard.NoVenueCanCover.selector, address(USDC), _deficitFor(1e18)
            )
        );
        board.fill(_board(), true, 1e18, 0, address(this));
    }

    /// @dev Unwinding a position that backs a loan can liquidate the maker, and Aave's own health
    ///      checks do not run for us. The refusal has to be ours.
    function test_AMakerWithDebtIsRefused() public onlyForked {
        _ship(CAPITAL);

        vm.prank(maker);
        IAaveBorrow(address(POOL)).borrow(address(WETH), 1e16, 2, 0, maker);

        // Not a bare `expectRevert()`: that passes on any revert at all, including one from a
        // typo in the test itself. The debt figure is Aave's and moves, so the selector is what
        // is matched — the error, not merely the failure.
        vm.expectPartialRevert(HelicoOracleBoard.MakerHasDebt.selector);
        board.fill(_board(), true, 1e18, 0, address(this));
    }

    function _deficitFor(uint256 amountIn) internal view returns (uint256) {
        return board.quoteExactIn(_board(), true, amountIn) - USDC.balanceOf(maker);
    }
}
