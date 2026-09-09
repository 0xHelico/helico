// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Aqua} from "@1inch/aqua/Aqua.sol";
import {IAqua} from "@1inch/aqua/interfaces/IAqua.sol";

import {HelicoOracleBoard, IHelicoOracleBoardCallback, IPriceFeed} from "../src/HelicoOracleBoard.sol";
import {Venue} from "../src/HelicoMandateSwap.sol";

/// @notice A maker holding only USDC, quoting from Chainlink, braking on its own inventory.
///
/// @dev This is the combination the project needs and neither existing app provides.
///      `HelicoMandateSwap` brakes itself but cannot quote a maker who holds one token —
///      `DegenerateReserves`. `FixedPriceBoard` quotes them but never brakes, so a market that
///      moves converts the whole position at yesterday's price.
///
///      Here the price comes from the live ETH/USD feed on Arbitrum One
///      (`0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612`, "ETH / USD", 8 decimals — read from the
///      chain rather than assumed) and the brake comes from the ledger: both quotes shift down as
///      base inventory accumulates, so selling into the board gets worse and buying the inventory
///      back gets better.
contract ForkOracleBoardTest is Test, IHelicoOracleBoardCallback {
    IERC20 constant USDC = IERC20(0xaf88d065e77c8cC2239327C5EDb3A432268e5831);
    IERC20 constant WETH = IERC20(0x82aF49447D8a07e3bd95BD0d56f35241523fBab1);
    IPriceFeed constant FEED = IPriceFeed(0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612);
    address constant USDC_WHALE = 0x47c031236e19d024b42f8AE6780E44A573170703;
    address constant WETH_WHALE = 0x70d95587d40A2caf56bd97485aB3Eec10Bee6336;

    Aqua aqua;
    HelicoOracleBoard board;
    address maker = address(0xA11CE);

    uint256 constant CAPITAL = 30_000e6; // the maker's entire position, all of it USDC
    uint256 constant SPREAD_BPS = 30; // 0.30% either side of the feed
    uint256 constant MAX_SKEW_BPS = 200; // 2% of bend at a full inventory
    uint256 constant BASE_CAP = 4e18; // four ETH, and no more

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
        board = new HelicoOracleBoard(IAqua(address(aqua)));
        // Fixed once. Computing it inside `_board()` made the hash move with `block.timestamp`,
        // so a test that warped was addressing a strategy nobody had shipped — and the failure
        // named the ledger rather than the clock.
        expiry = block.timestamp + 30 days;

        vm.prank(USDC_WHALE);
        USDC.transfer(maker, CAPITAL);
        vm.startPrank(maker);
        USDC.approve(address(aqua), type(uint256).max);
        // The token the maker does not hold yet still needs an approval, because the moment they
        // acquire any they may be asked to sell it. A one-sided maker who approves only what they
        // hold can buy and can never sell — and finds out on the first fill of the other side.
        WETH.approve(address(aqua), type(uint256).max);
        vm.stopPrank();

        vm.prank(WETH_WHALE);
        WETH.transfer(address(this), 20e18);
        vm.prank(USDC_WHALE);
        USDC.transfer(address(this), 50_000e6);
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
            // No venues: this file is about the price, and the wallet is the only source here.
            // `ForkOracleBoardYield.t.sol` is the one that empties the wallet into Aave.
            venues: new Venue[](0),
            app: address(board),
            salt: bytes32(uint256(1))
        });
    }

    function helicoOracleBoardCallback(address tokenIn, uint256 amountIn, address maker_, bytes32 hash)
        external
    {
        aqua.push(maker_, address(board), hash, tokenIn, amountIn);
    }

    /// @dev USDC named with the whole position, WETH named with nothing. The maker holds no WETH.
    function _ship() internal {
        address[] memory tokens = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        tokens[0] = address(USDC);
        amounts[0] = CAPITAL;
        tokens[1] = address(WETH);
        amounts[1] = 0;
        vm.prank(maker);
        aqua.ship(address(board), abi.encode(_board()), tokens, amounts);
    }

    function _feedAsUsdc() internal view returns (uint256) {
        (, int256 answer,,,) = FEED.latestRoundData();
        return uint256(answer) * 1e6 / 1e8;
    }

    // ── the claim ─────────────────────────────────────────────────────────────

    /// @dev The whole point, in one test: a position that is 100% USDC quotes a live market price
    ///      and fills, without the maker ever holding the other side first.
    function test_AMakerHoldingOnlyUSDCQuotesTheLiveMarket() public onlyForked {
        _ship();

        assertEq(WETH.balanceOf(maker), 0, "the maker holds no WETH at all");
        assertEq(USDC.balanceOf(maker), CAPITAL, "their entire position is USDC");

        uint256 mid = _feedAsUsdc();
        (uint256 bid, uint256 ask) = board.quotes(_board());

        // Empty inventory means no skew, so the quotes sit symmetrically around the feed.
        assertEq(bid, mid * (10_000 - SPREAD_BPS) / 10_000, "the bid is the feed less the spread");
        assertEq(ask, mid * (10_000 + SPREAD_BPS) / 10_000, "the ask is the feed plus the spread");

        uint256 amountIn = 1e18;
        uint256 before = USDC.balanceOf(address(this));
        uint256 amountOut = board.fill(_board(), true, amountIn, 0, address(this));

        assertEq(amountOut, bid, "one ETH sold at the bid");
        assertEq(USDC.balanceOf(address(this)) - before, amountOut, "the taker was paid, on chain");
        assertEq(WETH.balanceOf(maker), amountIn, "and the maker now holds the ETH they bought");

        emit log_named_uint("chainlink ETH/USD", mid);
        emit log_named_uint("bid              ", bid);
        emit log_named_uint("ask              ", ask);
        emit log_named_uint("paid for one ETH ", amountOut);
    }

    /// @dev The brake. A constant product gets this from its reserves; here it comes from the
    ///      ledger, and without it an oracle board converts an entire position at one price.
    function test_TheQuoteBendsDownAsInventoryAccumulates() public onlyForked {
        _ship();

        // Both quotes are read BEFORE the fill. Reading `ask0` afterwards compared a number with
        // itself and passed for that reason — a green assertion that proved nothing.
        (uint256 bid0, uint256 ask0) = board.quotes(_board());
        board.fill(_board(), true, 2e18, 0, address(this)); // half of baseCap
        (uint256 bid1, uint256 ask1) = board.quotes(_board());

        assertLt(bid1, bid0, "buying more ETH is now worse for the taker");

        uint256 mid = _feedAsUsdc();
        uint256 halfSkew = MAX_SKEW_BPS / 2;
        assertEq(bid1, mid * (10_000 - SPREAD_BPS - halfSkew) / 10_000, "bent by half the skew");
        assertEq(ask1, mid * (10_000 + SPREAD_BPS - halfSkew) / 10_000, "and the ask bent with it");

        // The ask falling is what pushes inventory back out: selling the ETH on is now cheaper
        // than it was before the maker acquired any.
        assertLt(ask1, ask0, "the inventory is offered back more cheaply than before it was bought");

        emit log_named_uint("bid, empty       ", bid0);
        emit log_named_uint("bid, half full   ", bid1);
    }

    /// @dev Skew bends but never refuses, and a bent price is still a price somebody takes once
    ///      the market has moved far enough. The cap is the refusal.
    function test_TheCapRefusesRatherThanMerelyDiscouraging() public onlyForked {
        _ship();

        board.fill(_board(), true, BASE_CAP, 0, address(this));
        assertEq(WETH.balanceOf(maker), BASE_CAP, "the maker is at the cap");

        // Not one wei: that rounds to nothing out and is refused as `ZeroAmount` before the cap
        // is ever consulted, which would have made this test pass for the wrong reason.
        uint256 nudge = 1e15;
        vm.expectRevert(
            abi.encodeWithSelector(HelicoOracleBoard.CapWouldBeExceeded.selector, BASE_CAP, nudge, BASE_CAP)
        );
        board.fill(_board(), true, nudge, 0, address(this));
    }

    /// @dev The inventory can be bought back, which is the half that makes this a market rather
    ///      than a one-way conversion.
    function test_TheInventoryCanBeBoughtBack() public onlyForked {
        _ship();
        board.fill(_board(), true, 2e18, 0, address(this));

        uint256 makerWethBefore = WETH.balanceOf(maker);
        uint256 wethOut = board.fill(_board(), false, 3_000e6, 0, address(this));

        assertGt(wethOut, 0, "the taker received ETH");
        assertEq(makerWethBefore - WETH.balanceOf(maker), wethOut, "out of the maker's own wallet");
    }

    /// @dev A board quoting a stale feed is a board being taken from. This is the check that
    ///      makes an oracle usable at all, and it is the one most easily left out.
    function test_AStaleFeedRefusesTheFill() public onlyForked {
        _ship();

        (,,, uint256 updatedAt,) = FEED.latestRoundData();
        vm.warp(updatedAt + 2 hours); // past the board's one-hour tolerance

        vm.expectRevert(
            abi.encodeWithSelector(HelicoOracleBoard.FeedStale.selector, updatedAt, block.timestamp, 1 hours)
        );
        board.fill(_board(), true, 1e18, 0, address(this));
    }

    /// @dev The maker's earnings, and the only ones there are. Selling one ETH in and buying it
    ///      straight back out costs the taker the round trip, which is what the maker keeps.
    function test_TheSpreadIsWhatTheMakerEarns() public onlyForked {
        _ship();

        uint256 before = USDC.balanceOf(address(this));
        uint256 usdcOut = board.fill(_board(), true, 1e18, 0, address(this));
        uint256 wethBack = board.fill(_board(), false, usdcOut, 0, address(this));

        assertLt(wethBack, 1e18, "the taker gets back less ETH than they sold");
        emit log_named_uint("sold  ", 1e18);
        emit log_named_uint("got back", wethBack);
        emit log_named_uint("taker USDC delta", USDC.balanceOf(address(this)) - before);
    }
}
