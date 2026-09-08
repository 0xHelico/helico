// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Aqua} from "@1inch/aqua/Aqua.sol";
import {IAqua} from "@1inch/aqua/interfaces/IAqua.sol";

import {FixedPriceBoard, IFixedPriceBoardCallback} from "./FixedPriceBoard.sol";

/// @notice Can a maker provide liquidity holding **one** token?
///
/// @dev The question came from reading `HelicoMandateSwap`, which refuses a zero balance on
///      either side with `DegenerateReserves`. The reason is the constant product it prices
///      with: `amountOut = amountIn * balanceOut / (balanceIn + amountIn)`, so a zero
///      `balanceIn` cancels `amountIn` top and bottom and pays out the entire opposite side for
///      two wei. That is real, and it is a fact about **our curve**, not about Aqua.
///
///      Aqua itself never prices anything — 81 lines, no `price`, no `quote`, no curve. So this
///      file builds the smallest app that reads its price from a field instead of a ratio, and
///      asks the chain whether one-sided liquidity then works.
///
///      Two answers, and the second is the one worth having:
///
///        1. Naming only USDC in the strategy does **not** work. `safeBalances` requires both
///           tokens to be in an active strategy, and `tokensCount` comes from `tokens.length`.
///           A token never named has `tokensCount == 0` and every read touching it reverts.
///        2. Naming both and giving one of them **zero** does work. `tokensCount` is 2 for both,
///           the reads succeed, and the maker's capital is still entirely USDC.
///
///      Real USDC and WETH on a fork of Arbitrum One, taken from a whale rather than minted, so
///      the tokens behave as they do in production.
contract ForkOneSidedFixedPriceTest is Test, IFixedPriceBoardCallback {
    IERC20 constant USDC = IERC20(0xaf88d065e77c8cC2239327C5EDb3A432268e5831);
    IERC20 constant WETH = IERC20(0x82aF49447D8a07e3bd95BD0d56f35241523fBab1);
    address constant USDC_WHALE = 0x47c031236e19d024b42f8AE6780E44A573170703;
    address constant WETH_WHALE = 0x70d95587d40A2caf56bd97485aB3Eec10Bee6336;

    Aqua aqua;
    FixedPriceBoard board;
    address maker = address(0xA11CE);

    /// @dev 3,000 USDC for one WETH. USDC has six decimals and WETH eighteen, so the price is
    ///      "USDC units per 1e18 of WETH" and needs no further scaling.
    uint256 constant PRICE = 3_000e6;
    uint256 constant ON_OFFER = 30_000e6;

    bool forked;

    function setUp() public {
        try vm.createSelectFork("arbitrum") {
            forked = true;
        } catch {
            forked = false;
            return;
        }
        aqua = new Aqua();
        board = new FixedPriceBoard(IAqua(address(aqua)));

        // The maker holds USDC and nothing else. Every assertion below leans on this.
        vm.prank(USDC_WHALE);
        USDC.transfer(maker, ON_OFFER);
        vm.prank(maker);
        USDC.approve(address(aqua), type(uint256).max);

        // The taker is this test contract, and it holds the WETH it will pay with.
        vm.prank(WETH_WHALE);
        WETH.transfer(address(this), 10e18);
        WETH.approve(address(aqua), type(uint256).max);
    }

    modifier onlyForked() {
        if (!forked) {
            emit log("SKIP: no `arbitrum` RPC endpoint configured");
            return;
        }
        _;
    }

    function _board() internal view returns (FixedPriceBoard.Board memory) {
        return FixedPriceBoard.Board({
            maker: maker,
            sell: address(USDC),
            buy: address(WETH),
            priceE18: PRICE,
            app: address(board),
            salt: bytes32(uint256(1))
        });
    }

    /// @dev The taker's half of the fill: pay for what the app already handed over.
    function fixedPriceBoardCallback(address buyToken, uint256 amountIn, address maker_, bytes32 hash)
        external
    {
        aqua.push(maker_, address(board), hash, buyToken, amountIn);
    }

    // ── the two answers ───────────────────────────────────────────────────────

    /// @dev Naming one token is not enough, and the reason is bookkeeping rather than pricing.
    ///      `ship` sets `tokensCount` from `tokens.length`, so WETH is left at zero and the
    ///      first read that touches it reverts — before any price is ever computed.
    function test_NamingOnlyOneTokenLeavesTheOtherUnreadable() public onlyForked {
        address[] memory tokens = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        tokens[0] = address(USDC);
        amounts[0] = ON_OFFER;

        vm.prank(maker);
        aqua.ship(address(board), abi.encode(_board()), tokens, amounts);

        (, uint8 usdcCount) = aqua.rawBalances(maker, address(board), board.hashOf(_board()), address(USDC));
        (, uint8 wethCount) = aqua.rawBalances(maker, address(board), board.hashOf(_board()), address(WETH));
        assertEq(usdcCount, 1, "USDC was named");
        assertEq(wethCount, 0, "WETH was not, so it is not in an active strategy");

        vm.expectRevert();
        board.fill(_board(), 1e18, address(this));
    }

    /// @dev The whole question, answered. Both tokens are named; one of them is zero; the maker
    ///      holds no WETH at all and provides liquidity anyway.
    function test_AMakerHoldingOnlyUSDCCanProvideLiquidity() public onlyForked {
        _shipOneSided();

        assertEq(WETH.balanceOf(maker), 0, "the maker is deliberately holding no WETH");
        assertEq(USDC.balanceOf(maker), ON_OFFER, "and all of their capital is USDC");

        uint256 amountIn = 2e18;
        uint256 expected = amountIn * PRICE / 1e18; // 6,000 USDC

        uint256 takerUsdcBefore = USDC.balanceOf(address(this));
        uint256 amountOut = board.fill(_board(), amountIn, address(this));

        assertEq(amountOut, expected, "the price on the board is the price paid");
        assertEq(USDC.balanceOf(address(this)) - takerUsdcBefore, amountOut, "the taker was paid, on chain");
        assertEq(USDC.balanceOf(maker), ON_OFFER - amountOut, "out of the maker's own wallet");
        assertEq(WETH.balanceOf(maker), amountIn, "and the maker now holds the WETH they bought");

        // The question this answers: does the ETH the maker just bought land in Aqua's ledger by
        // itself, or does the maker have to ship again? `push` does both halves in one call —
        // `balance.store(prevBalance + amount, ...)` then `safeTransferFrom(taker, maker, ...)`.
        // So the ledger is credited and the wallet is credited, in the taker's own transaction.
        (uint248 wethLedger,) = aqua.rawBalances(maker, address(board), board.hashOf(_board()), address(WETH));
        (uint248 usdcLedger,) = aqua.rawBalances(maker, address(board), board.hashOf(_board()), address(USDC));
        assertEq(wethLedger, amountIn, "the WETH bought is in the ledger, with nobody shipping again");
        assertEq(usdcLedger, ON_OFFER - amountOut, "and the USDC side went down by exactly what left");

        emit log_named_uint("maker USDC before", ON_OFFER);
        emit log_named_uint("maker WETH before", 0);
        emit log_named_uint("paid to taker    ", amountOut);
        emit log_named_uint("maker USDC after ", USDC.balanceOf(maker));
        emit log_named_uint("maker WETH after ", WETH.balanceOf(maker));
        emit log_named_uint("WETH in the ledger", wethLedger);
    }

    /// @dev The price does not move with the fills, which is the trade a fixed board makes. Two
    ///      identical fills pay identically — where a constant product would have charged the
    ///      second one more. This is why such a board has to be re-shipped when the market moves:
    ///      nothing here notices that it has become the wrong price.
    function test_ThePriceDoesNotMoveNoMatterHowMuchIsTaken() public onlyForked {
        _shipOneSided();

        uint256 first = board.fill(_board(), 1e18, address(this));
        uint256 second = board.fill(_board(), 1e18, address(this));

        assertEq(first, PRICE, "the first fill pays the board price");
        assertEq(second, first, "and so does the second, unchanged");
    }

    /// @dev The board cannot be drained past what was shipped, even though the maker's wallet
    ///      might hold more. The ledger is the budget — that is the property `dock` revokes.
    function test_TheBoardCannotPayOutMoreThanWasShipped() public onlyForked {
        _shipOneSided();

        vm.prank(USDC_WHALE);
        USDC.transfer(maker, 50_000e6); // far more in the wallet than on the board

        vm.expectRevert(
            abi.encodeWithSelector(FixedPriceBoard.NotEnoughOnTheBoard.selector, 33_000e6, ON_OFFER)
        );
        board.fill(_board(), 11e18, address(this));
    }

    function _shipOneSided() internal {
        address[] memory tokens = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        tokens[0] = address(USDC);
        amounts[0] = ON_OFFER;
        tokens[1] = address(WETH);
        amounts[1] = 0; // named, so it is readable; zero, so no WETH is required

        vm.prank(maker);
        aqua.ship(address(board), abi.encode(_board()), tokens, amounts);
    }
}
