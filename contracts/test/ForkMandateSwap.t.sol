// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {IAqua} from "@1inch/aqua/interfaces/IAqua.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {DeployMandateSwap} from "../script/DeployMandateSwap.s.sol";
import {HelicoMandateSwap, SwapMandate, Venue} from "../src/HelicoMandateSwap.sol";
import {PayingTaker} from "./MandateTakers.sol";

/// @notice The app against the Aqua that 1inch actually deployed, on the chain we will deploy to.
///
/// @dev The unit suite deploys its own Aqua, which proves the app is right about Aqua's
///      behaviour but proves nothing about the address we are about to hard-code into a
///      broadcast. This one closes that gap: it deploys through the same `deploy()` the script
///      broadcasts, against `DeployMandateSwap.AQUA`, and then trades real USDC for real WETH
///      out of a maker's wallet.
///
///      It exists because of a specific near miss. The Aqua address was typed by hand and one
///      character was wrong. It compiled — `forge fmt` rewrites an address literal's EIP-55
///      checksum to match whatever hex is present, so solc's mistyped-address check passes on
///      a mistyped address. Nothing in the unit suite could have caught it, because nothing in
///      the unit suite touches that constant.
contract ForkMandateSwapTest is Test {
    uint256 constant ARBITRUM_ONE = 42161;

    IERC20 constant USDC = IERC20(0xaf88d065e77c8cC2239327C5EDb3A432268e5831);
    IERC20 constant WETH = IERC20(0x82aF49447D8a07e3bd95BD0d56f35241523fBab1);

    uint256 constant RESERVE_USDC = 100_000e6;
    uint256 constant RESERVE_WETH = 30e18;
    uint256 constant AMOUNT_IN = 1000e6;

    DeployMandateSwap script;
    HelicoMandateSwap app;
    IAqua aqua;
    PayingTaker taker;

    address maker = address(0xA11CE);

    bool forked;

    function setUp() public {
        try vm.createSelectFork("arbitrum") {
            forked = block.chainid == ARBITRUM_ONE;
        } catch {
            forked = false;
        }
        if (!forked) {
            emit log("no endpoint: set ARBITRUM_RPC_URL to run this fork suite");
            vm.skip(true);
            return;
        }

        script = new DeployMandateSwap();
        aqua = IAqua(script.AQUA());
        app = script.deploy(aqua);

        deal(address(USDC), maker, RESERVE_USDC);
        deal(address(WETH), maker, RESERVE_WETH);
        vm.startPrank(maker);
        USDC.approve(address(aqua), type(uint256).max);
        WETH.approve(address(aqua), type(uint256).max);
        vm.stopPrank();

        taker = new PayingTaker(aqua);
        deal(address(USDC), address(taker), 10_000e6);
        taker.approveAqua(address(USDC));
        taker.approveAqua(address(WETH));
    }

    /// @dev The constant the broadcast will use, held against the chain. `rawBalances`
    ///      answering for a strategy nobody shipped is Aqua's documented behaviour and is not
    ///      something an arbitrary contract at that address would do.
    function test_TheAddressTheScriptWillBroadcastToIsAqua() public {
        address a = script.AQUA();
        assertGt(a.code.length, 0, "no code at the pinned Aqua address");

        (uint256 balance, uint8 tokensCount) =
            aqua.rawBalances(address(1), address(2), bytes32(uint256(3)), address(4));
        assertEq(balance, 0, "an unknown strategy must read as empty");
        assertEq(tokensCount, 0, "an unknown strategy must read as inactive");

        vm.expectRevert(
            abi.encodeWithSelector(
                IAqua.SafeBalancesForTokenNotInActiveStrategy.selector,
                address(1),
                address(2),
                bytes32(uint256(3)),
                address(4)
            )
        );
        aqua.safeBalances(address(1), address(2), bytes32(uint256(3)), address(4), address(5));
    }

    /// @dev The whole path, on the chain, with tokens that exist: ship, swap, settle. The
    ///      assertions are about the maker's *wallet*, because that is the claim -- the
    ///      liquidity never moved anywhere to be traded.
    function test_ARealSwapMovesTokensStraightOutOfTheMakersWallet() public {
        uint256 out = _quoteOffChain(RESERVE_USDC, RESERVE_WETH, AMOUNT_IN);
        SwapMandate memory m = SwapMandate({
            maker: maker,
            token0: address(USDC),
            token1: address(WETH),
            feeBps: 30,
            maxOut0: type(uint256).max,
            maxOut1: out,
            expiry: uint64(block.timestamp + 1 days),
            agent: address(taker),
            salt: "fork",
            venues: new Venue[](0)
        });
        bytes32 hash = _ship(m);

        uint256 makerUsdcBefore = USDC.balanceOf(maker);
        uint256 makerWethBefore = WETH.balanceOf(maker);
        address beneficiary = address(0xB0B);

        uint256 got = taker.swap(app, m, true, AMOUNT_IN, 0, beneficiary);

        assertEq(got, out, "the swap must land exactly on the ceiling");
        assertGt(got, 0, "a zero output would satisfy every assertion here and mean nothing");

        // The maker's own wallet is where both sides moved.
        assertEq(USDC.balanceOf(maker), makerUsdcBefore + AMOUNT_IN, "input arrives in the wallet");
        assertEq(WETH.balanceOf(maker), makerWethBefore - got, "output leaves the wallet");
        assertEq(WETH.balanceOf(beneficiary), got, "and reaches the named recipient");

        // Neither Aqua nor the app was ever a custodian.
        assertEq(USDC.balanceOf(address(aqua)), 0, "Aqua holds no USDC");
        assertEq(WETH.balanceOf(address(aqua)), 0, "Aqua holds no WETH");
        assertEq(USDC.balanceOf(address(app)), 0, "the app holds no USDC");
        assertEq(WETH.balanceOf(address(app)), 0, "the app holds no WETH");

        (uint256 ledgerUsdc,) = aqua.rawBalances(maker, address(app), hash, address(USDC));
        assertEq(ledgerUsdc, RESERVE_USDC + AMOUNT_IN, "the ledger tracked the same movement");
    }

    /// @dev A mandate is enforceable against real tokens, not only against a mock.
    function test_TheCeilingStillRefusesOnTheRealChain() public {
        uint256 out = _quoteOffChain(RESERVE_USDC, RESERVE_WETH, AMOUNT_IN);
        SwapMandate memory m = SwapMandate({
            maker: maker,
            token0: address(USDC),
            token1: address(WETH),
            feeBps: 30,
            maxOut0: type(uint256).max,
            maxOut1: out - 1,
            expiry: uint64(block.timestamp + 1 days),
            agent: address(taker),
            salt: "fork-ceiling",
            venues: new Venue[](0)
        });
        _ship(m);

        vm.expectRevert(
            abi.encodeWithSelector(
                HelicoMandateSwap.MandateCeilingExceeded.selector, address(WETH), out, out - 1
            )
        );
        taker.swap(app, m, true, AMOUNT_IN, 0, address(taker));
    }

    function _ship(SwapMandate memory m) private returns (bytes32) {
        address[] memory tokens = new address[](2);
        tokens[0] = m.token0;
        tokens[1] = m.token1;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = RESERVE_USDC;
        amounts[1] = RESERVE_WETH;
        vm.prank(m.maker);
        return aqua.ship(address(app), abi.encode(m), tokens, amounts);
    }

    function _quoteOffChain(uint256 balanceIn, uint256 balanceOut, uint256 amountIn)
        private
        pure
        returns (uint256)
    {
        uint256 withFee = amountIn * (10_000 - 30) / 10_000;
        return withFee * balanceOut / (balanceIn + withFee);
    }
}
