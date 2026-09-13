// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IAqua} from "@1inch/aqua/interfaces/IAqua.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {HelicoMandateSwap, SwapMandate} from "../src/HelicoMandateSwap.sol";
import {HelicoTaker} from "../src/HelicoTaker.sol";
import {DeployHelicoTaker} from "../script/DeployHelicoTaker.s.sol";

/// @notice A plain wallet takes the live two-sided mandate on Arbitrum One, through `HelicoTaker`,
///         and the USDC it receives was a Morpho position one call earlier.
///
/// @dev The mandate is the one `0x8E0f7e67…1807` shipped at block 504,496,732 — 996,491 USDC and
///      0.000397 WETH, four venues — copied byte for byte from Aqua's `Shipped` event, so
///      `keccak256` of it is `0x576c16fb…` and the app answers for the position that exists. The
///      account's USDC is in Morpho (0.986) with 0.01 idle, so any fill above a cent has to be
///      covered out of the lending position inside the swap. That is the sentence the product is
///      built on, and this is it happening against the real account, the real Aqua, the real
///      Morpho, on a fork of the block the test runs at.
///
///      Skipped without an endpoint, like every fork suite here. It also skips once the mandate
///      has expired on chain (24 hours from shipping), since a fill against an expired mandate is
///      refused by the app and would test nothing about the taker.
contract ForkHelicoTakerLive is Test {
    uint256 constant ARBITRUM_ONE = 42161;
    IAqua constant AQUA = IAqua(0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a);
    HelicoMandateSwap constant APP = HelicoMandateSwap(0x0524a353dfab33CD362593ae8e97707764Fb6041);
    IERC20 constant USDC = IERC20(0xaf88d065e77c8cC2239327C5EDb3A432268e5831);
    IERC20 constant WETH = IERC20(0x82aF49447D8a07e3bd95BD0d56f35241523fBab1);
    IERC20 constant HM_USDC = IERC20(0xBBa798A61f0D7D1AE51466Fd4045Cd2Ea25c9A29);
    address constant ACCOUNT = 0x8E0f7e6701c2e9b4F2591161B92c51b431591807;
    bytes32 constant HASH = 0x576c16fb15a448b1156fecc0391ff194554dfbf79e6bfea1084e923f62a9d5fa;

    /// @dev Aqua's `Shipped` bytes for the mandate, verbatim.
    bytes constant STRATEGY =
        hex"00000000000000000000000000000000000000000000000000000000000000200000000000000000000000008e0f7e6701c2e9b4f2591161b92c51b431591807000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e583100000000000000000000000082af49447d8a07e3bd95bd0d56f35241523fbab1000000000000000000000000000000000000000000000000000000000000001e00000000000000000000000000000000000000000000000000000000000f348b0000000000000000000000000000000000000000000000000001695e9369332a000000000000000000000000000000000000000000000000000000006aa6fbba0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001a09720f5a200000000000000000000000000000000000000000000000000000000000001400000000000000000000000000000000000000000000000000000000000000004000000000000000000000000794a61358d6845594f94dc1db02a252b5b4814ad000000000000000000000000724dc807b04555b71ed48a6896b6f41593b8c637000000000000000000000000e50fa9b3c56ffb159cb0fca61f5c9d750e8128c800000000000000000000000000000000000000000000000000000000000000000000000000000000000000001ec57ce1ddfdc7a4ebf4f54aedee19ab73fcbb2e0000000000000000000000001ec57ce1ddfdc7a4ebf4f54aedee19ab73fcbb2e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000bba798a61f0d7d1ae51466fd4045cd2ea25c9a29000000000000000000000000bba798a61f0d7d1ae51466fd4045cd2ea25c9a2900000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000b0a125f539237b553025e2cb180f9c40b25918cd0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000b0a125f539237b553025e2cb180f9c40b25918cd0000000000000000000000000000000000000000000000000000000000000001";

    HelicoTaker taker;
    address wallet = makeAddr("a-wallet-with-some-weth");
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
        SwapMandate memory m = abi.decode(STRATEGY, (SwapMandate));
        if (block.timestamp >= m.expiry) {
            emit log("the live mandate has expired; nothing to take");
            vm.skip(true);
            return;
        }
        // Through the script, so the suite exercises the deployment that will be broadcast.
        taker = new DeployHelicoTaker().run();
    }

    function test_TheBytesAreTheMandate() public view {
        assertEq(keccak256(STRATEGY), HASH, "the copied bytes are not the shipped mandate");
        SwapMandate memory m = abi.decode(STRATEGY, (SwapMandate));
        assertEq(m.maker, ACCOUNT);
        assertEq(m.token0, address(USDC));
        assertEq(m.token1, address(WETH));
        assertEq(m.venues.length, 4, "the mandate names four venues");
        assertEq(APP.mandateHash(m), HASH, "the app hashes it to the same number");
    }

    /// @dev Sell 0.0001 WETH for USDC. The account holds 0.01 USDC idle and the rest in Morpho,
    ///      so the ~0.2 USDC this buys is covered out of the lending position, inside the swap.
    function test_AWalletTakesUsdcThatWasEarningInMorpho() public {
        SwapMandate memory m = abi.decode(STRATEGY, (SwapMandate));
        uint256 amountIn = 1e14; // 0.0001 WETH
        uint256 quoted = APP.quoteExactIn(m, false, amountIn);
        assertGt(quoted, 10_000, "the fill must exceed the idle cent, or Morpho is never touched");

        deal(address(WETH), wallet, amountIn);
        uint256 usdcIdleBefore = USDC.balanceOf(ACCOUNT);
        uint256 hmBefore = HM_USDC.balanceOf(ACCOUNT);
        uint256 wethBefore = WETH.balanceOf(ACCOUNT);
        (uint248 ledgerUsdcBefore,) = AQUA.rawBalances(ACCOUNT, address(APP), HASH, address(USDC));

        vm.startPrank(wallet);
        WETH.approve(address(taker), amountIn);
        uint256 amountOut = taker.take(m, false, amountIn, quoted, block.timestamp + 300);
        vm.stopPrank();

        assertEq(amountOut, quoted, "the fill pays what the quote said");
        assertEq(USDC.balanceOf(wallet), quoted, "the wallet holds the USDC");
        assertEq(WETH.balanceOf(wallet), 0, "and paid the WETH");
        assertEq(WETH.balanceOf(ACCOUNT), wethBefore + amountIn, "the maker received the WETH");
        // **The wallet is spent first, always** (`_cover`): the idle cent goes to the taker and
        // only the deficit is redeemed from Morpho — so the idle side reads zero afterwards and
        // the Morpho position is smaller by what the cent could not cover.
        assertEq(usdcIdleBefore, 10_000, "the account had one idle cent going in");
        assertEq(USDC.balanceOf(ACCOUNT), 0, "the idle cent was spent first");
        assertLt(HM_USDC.balanceOf(ACCOUNT), hmBefore, "Morpho shares were redeemed to cover the rest");
        (uint248 ledgerUsdcAfter,) = AQUA.rawBalances(ACCOUNT, address(APP), HASH, address(USDC));
        assertEq(
            uint256(ledgerUsdcBefore) - uint256(ledgerUsdcAfter), quoted, "Aqua's ledger fell by the fill"
        );
        // Nothing sticks to the taker or to the app.
        assertEq(USDC.balanceOf(address(taker)), 0);
        assertEq(WETH.balanceOf(address(taker)), 0);
        assertEq(WETH.allowance(address(taker), address(AQUA)), 0, "the approval was consumed by the push");
        assertEq(HM_USDC.balanceOf(address(APP)), 0, "the app keeps no receipt");
    }

    /// @dev The other direction: sell USDC for WETH, which is in Compound v3 ETH.
    function test_AWalletTakesWethThatWasEarningInCompound() public {
        SwapMandate memory m = abi.decode(STRATEGY, (SwapMandate));
        uint256 amountIn = 200_000; // 0.20 USDC
        uint256 quoted = APP.quoteExactIn(m, true, amountIn);
        assertGt(quoted, 10_000, "must exceed the idle wei, or Compound is never touched");
        IERC20 hcWeth = IERC20(0xb0A125F539237b553025e2cb180f9C40B25918cD);
        uint256 hcBefore = hcWeth.balanceOf(ACCOUNT);

        deal(address(USDC), wallet, amountIn);
        vm.startPrank(wallet);
        USDC.approve(address(taker), amountIn);
        uint256 amountOut = taker.take(m, true, amountIn, quoted, block.timestamp + 300);
        vm.stopPrank();

        assertEq(amountOut, quoted);
        assertEq(WETH.balanceOf(wallet), quoted, "the wallet holds the WETH");
        assertLt(hcWeth.balanceOf(ACCOUNT), hcBefore, "Compound shares were redeemed to cover it");
    }

    function test_OnlyTheAppMayMakeItPay() public {
        vm.expectRevert(abi.encodeWithSelector(HelicoTaker.OnlyApp.selector, address(this)));
        taker.helicoMandateSwapCallback(address(WETH), address(USDC), 1, 1, ACCOUNT, address(APP), HASH, "");
    }

    function test_AStaleDeadlineIsRefusedBeforeAnythingMoves() public {
        SwapMandate memory m = abi.decode(STRATEGY, (SwapMandate));
        vm.prank(wallet);
        vm.expectRevert(
            abi.encodeWithSelector(HelicoTaker.Expired.selector, block.timestamp - 1, block.timestamp)
        );
        taker.take(m, false, 1e14, 0, block.timestamp - 1);
    }
}
