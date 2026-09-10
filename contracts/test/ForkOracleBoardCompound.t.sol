// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Aqua} from "@1inch/aqua/Aqua.sol";
import {IAqua} from "@1inch/aqua/interfaces/IAqua.sol";

import {HelicoOracleBoard, IHelicoOracleBoardCallback, IPriceFeed} from "../src/HelicoOracleBoard.sol";
import {Venue} from "../src/HelicoMandateSwap.sol";
import {ReceiptKind} from "../src/ReceiptMath.sol";
import {CompoundVenue} from "../src/CompoundVenue.sol";
import {MorphoVenue} from "../src/MorphoVenue.sol";
import {IComet} from "../src/IComet.sol";
import {IERC4626Vault} from "../src/IERC4626Vault.sol";

/// @notice The other deployed app, with the venues that are not Aave.
///
/// @dev `HelicoOracleBoard` carries its own copy of `_cover` and its own copy of the
///      `UNDERLYING_ASSET_ADDRESS()` check — deliberately the same ones, so the two apps cannot
///      drift about what an unwind means. "Deliberately the same" is a claim about source, though,
///      and this file is the one that makes it a claim about the chain.
///
///      It matters more here than anywhere. This is the app built for a maker holding **one**
///      token, which is exactly the maker whose whole position is in a lending market — so a board
///      that cannot settle out of Compound or Morpho is a board that cannot serve the maker it was
///      written for.
contract ForkOracleBoardCompoundTest is Test, IHelicoOracleBoardCallback {
    IERC20 constant USDC = IERC20(0xaf88d065e77c8cC2239327C5EDb3A432268e5831);
    IERC20 constant WETH = IERC20(0x82aF49447D8a07e3bd95BD0d56f35241523fBab1);
    IComet constant COMET = IComet(0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf);
    IERC4626Vault constant MORPHO_VAULT = IERC4626Vault(0x5c0C306Aaa9F877de636f4d5822cA9F2E81563BA);
    IPriceFeed constant FEED = IPriceFeed(0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612);
    address constant USDC_WHALE = 0x47c031236e19d024b42f8AE6780E44A573170703;
    address constant WETH_WHALE = 0x70d95587d40A2caf56bd97485aB3Eec10Bee6336;

    Aqua aqua;
    HelicoOracleBoard board;
    CompoundVenue compound;
    MorphoVenue morpho;

    address maker = address(0xA11CE);
    address bystander = address(0xB0B);

    uint256 constant CAPITAL = 30_000e6;
    uint256 constant BYSTANDER_CAPITAL = 5_000e6;
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
        compound = new CompoundVenue(COMET);
        morpho = new MorphoVenue(MORPHO_VAULT);
        expiry = block.timestamp + 365 days;

        vm.prank(USDC_WHALE);
        USDC.transfer(maker, CAPITAL);

        vm.startPrank(maker);
        // Every unit into Compound. The wallet is left with nothing, which is the case this app
        // exists for and the case a cover has to answer.
        USDC.approve(address(compound), type(uint256).max);
        compound.supply(address(USDC), CAPITAL, maker, 0);
        USDC.approve(address(aqua), type(uint256).max);
        WETH.approve(address(aqua), type(uint256).max);
        compound.approve(address(aqua), type(uint256).max);
        morpho.approve(address(aqua), type(uint256).max);
        vm.stopPrank();

        vm.prank(USDC_WHALE);
        USDC.transfer(bystander, BYSTANDER_CAPITAL);
        vm.startPrank(bystander);
        USDC.approve(address(compound), type(uint256).max);
        compound.supply(address(USDC), BYSTANDER_CAPITAL, bystander, 0);
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

    function _venues() internal view returns (Venue[] memory v) {
        v = new Venue[](1);
        v[0] = Venue({
            pool: address(compound),
            receipt0: address(compound),
            receipt1: address(0),
            kind: ReceiptKind.SharePriced
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
            salt: bytes32(uint256(11))
        });
    }

    function helicoOracleBoardCallback(address tokenIn, uint256 amountIn, address maker_, bytes32 hash)
        external
    {
        aqua.push(maker_, address(board), hash, tokenIn, amountIn);
    }

    function _ship() internal {
        address[] memory tokens = new address[](3);
        uint256[] memory amounts = new uint256[](3);
        tokens[0] = address(USDC);
        amounts[0] = CAPITAL;
        tokens[1] = address(WETH);
        amounts[1] = 0;
        tokens[2] = address(compound);
        amounts[2] = compound.balanceOf(maker);
        vm.prank(maker);
        aqua.ship(address(board), abi.encode(_board()), tokens, amounts);
    }

    /// @dev The three properties at once, and the combination is the product: one token, a live
    ///      Chainlink price, and the capital in Compound rather than Aave.
    function test_AOneSidedMakerIsPaidOutOfCompound() public onlyForked {
        _ship();

        assertEq(USDC.balanceOf(maker), 0, "the maker's wallet is empty");
        assertEq(WETH.balanceOf(maker), 0, "and they hold no ETH: this is a one-sided board");

        uint256 sharesBefore = compound.balanceOf(maker);
        uint256 valueBefore = compound.previewRedeem(sharesBefore);
        uint256 bystanderBefore = compound.previewRedeem(compound.balanceOf(bystander));

        uint256 expected = board.quoteExactIn(_board(), true, 1e18);
        uint256 takerBefore = USDC.balanceOf(address(this));
        uint256 out = board.fill(_board(), true, 1e18, 0, address(this));

        assertEq(out, expected, "paid at the quoted price");
        assertEq(USDC.balanceOf(address(this)) - takerBefore, out, "the taker was paid, on chain");
        assertLt(compound.balanceOf(maker), sharesBefore, "and Compound paid for it");
        assertEq(WETH.balanceOf(maker), 1e18, "the maker holds the ETH they bought");
        assertEq(compound.balanceOf(address(board)), 0, "the board kept no receipt");

        assertApproxEqAbs(
            compound.previewRedeem(compound.balanceOf(maker)) + out,
            valueBefore,
            3,
            "the position lost what left"
        );
        assertApproxEqAbs(
            compound.previewRedeem(compound.balanceOf(bystander)),
            bystanderBefore,
            3,
            "and nobody else gained"
        );

        emit log_named_uint("chainlink price", expected);
        emit log_named_uint("paid to taker  ", out);
        emit log_named_uint("shares burned  ", sharesBefore - compound.balanceOf(maker));
    }

    /// @dev The same board, the same maker, a different protocol. `venues` is a list the maker
    ///      ships and the app never re-ranks, so swapping which protocol backs a board is data.
    function test_TheSameBoardWorksAgainstMorpho() public onlyForked {
        vm.startPrank(maker);
        uint256 held = compound.balanceOf(maker);
        compound.withdraw(address(USDC), compound.previewRedeem(held) - 2, maker);
        USDC.approve(address(morpho), type(uint256).max);
        morpho.supply(address(USDC), USDC.balanceOf(maker), maker, 0);
        vm.stopPrank();

        assertEq(USDC.balanceOf(maker), 0, "the wallet is empty again, in a different protocol");

        HelicoOracleBoard.Board memory b = _board();
        b.venues[0] = Venue({
            pool: address(morpho),
            receipt0: address(morpho),
            receipt1: address(0),
            kind: ReceiptKind.SharePriced
        });
        b.salt = bytes32(uint256(12));

        address[] memory tokens = new address[](3);
        uint256[] memory amounts = new uint256[](3);
        tokens[0] = address(USDC);
        amounts[0] = CAPITAL;
        tokens[1] = address(WETH);
        amounts[1] = 0;
        tokens[2] = address(morpho);
        amounts[2] = morpho.balanceOf(maker);
        vm.prank(maker);
        aqua.ship(address(board), abi.encode(b), tokens, amounts);

        uint256 sharesBefore = morpho.balanceOf(maker);
        uint256 out = board.fill(b, true, 1e18, 0, address(this));

        assertGt(out, 0, "the taker was paid");
        assertLt(morpho.balanceOf(maker), sharesBefore, "out of Morpho this time");
        assertEq(morpho.balanceOf(address(board)), 0, "and the board kept no receipt");

        emit log_named_uint("paid out of morpho", out);
    }
}
