// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IAqua} from "@1inch/aqua/interfaces/IAqua.sol";
import {ISwapVM} from "@1inch/swap-vm/interfaces/ISwapVM.sol";
import {MakerTraitsLib} from "@1inch/swap-vm/libs/MakerTraits.sol";
import {TakerTraitsLib} from "@1inch/swap-vm/libs/TakerTraits.sol";

import {Call} from "../src/AccountAuth.sol";
import {DeployAccountFactory} from "../script/DeployAccountFactory.s.sol";
import {DeploySwapVMRouter} from "../script/DeploySwapVMRouter.s.sol";
import {HelicoAccount} from "../src/HelicoAccount.sol";
import {HelicoAccountFactory} from "../src/HelicoAccountFactory.sol";
import {HelicoAquaSwapVMRouter} from "../src/swapvm/HelicoAquaSwapVMRouter.sol";

/// @notice Does a concentrated liquidity band compose with settling out of a lending position?
///
/// @dev Asked by @rifkyeasy on #265, and the shape of the question matters. `ForkSwapVMYieldCover`
///      and `HelicoOracleBoard` both prove that unwinding an Aave position composes with pricing —
///      but in Solidity **we** wrote, where the unwind runs before the quote because we chose that
///      order. This is two published instructions inside SwapVM's own program loop, where the
///      order is a byte in a program and the arithmetic is Degensoft's.
///
///      **The issue proposed pairing them as `[18][34]`, and that cannot work in either order.**
///      Reading the two sources rather than guessing:
///
///        - `_xycConcentrateGrowLiquidity2D` opens with
///          `require(amountIn == 0 || amountOut == 0, ConcentrateShouldBeUsedBeforeSwapAmountsComputed)`.
///          It adds virtual reserves so a constant product prices like a band, so it must run
///          **before** any swap.
///        - `_aquaYieldCoverXD` reads `ctx.swap.amountOut` and returns immediately when it is
///          zero. It can only know what to unwind **after** a swap has been priced.
///
///      One needs the amount unset and the other needs it set, so no two-instruction program
///      contains both usefully. The composition is three instructions, and this file proves the
///      working one and both failing ones — because a test that only shows the happy path cannot
///      tell "it works" from "the second instruction did nothing".
contract ForkSwapVMConcentrateCoverTest is Test {
    address constant AQUA = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;
    address constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    address constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
    address constant AAVE_POOL = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;
    address constant AUSDC = 0x724dc807b04555b71ed48a6896b6F41593b8C637;
    address constant USDC_WHALE = 0x47c031236e19d024b42f8AE6780E44A573170703;

    /// @dev Positions in the source, minus one for the word the length overwrites. Read off the
    ///      source directly and a program calls the instruction next door.
    uint8 constant OP_SWAP = 17; // XYCSwap._xycSwapXD
    uint8 constant OP_CONCENTRATE = 18; // XYCConcentrate._xycConcentrateGrowLiquidity2D

    uint256 constant COMMITTED_USDC = 43_000e6;
    uint256 constant SUPPLIED_USDC = 38_000e6;
    uint256 constant COMMITTED_WETH = 20e18;

    /// @dev `P = tokenGt/tokenLt` in **raw units**, and WETH sorts below USDC, so P is
    ///      `USDC(6dp) / WETH(18dp)`. At the committed balances:
    ///
    ///          P     = 43_000e6 / 20e18 = 2.15e-9
    ///          sqrt  = 4.6368e-5
    ///          fixed = 4.6368e13          in the instruction's 1e18 fixed point
    ///
    ///      The band brackets that, which is what makes this a live position rather than a range
    ///      the price has already left.
    ///
    ///      **Getting this wrong is silent.** The first version of this file used `1.2e12`
    ///      through `1.8e12`, three orders of magnitude low, from mis-multiplying the decimal
    ///      difference. Nothing reverted: the swap simply paid 16 USDC for 5 WETH, and the test
    ///      that caught it was the one comparing the band against no band at all.
    uint256 constant SQRT_P_MIN = 3.9e13;
    uint256 constant SQRT_P_MAX = 5.4e13;

    HelicoAccountFactory factory;
    HelicoAquaSwapVMRouter router;

    address owner;
    address account;
    address taker = address(0x7A6E7);

    bool forked;

    function setUp() public {
        try vm.createSelectFork("arbitrum") {
            forked = true;
        } catch {
            emit log("no endpoint: set ARBITRUM_RPC_URL to run this fork suite");
            return;
        }

        owner = makeAddr("concentrate-owner");

        (, factory) = new DeployAccountFactory().deploy(address(0xC2E));
        router = new DeploySwapVMRouter().deploy(address(this));

        account = factory.accountFor(owner);
        factory.open(owner);

        vm.prank(USDC_WHALE);
        IERC20(USDC).transfer(account, COMMITTED_USDC);
        deal(WETH, account, COMMITTED_WETH);

        // The position the whole question is about: most of the USDC is earning, so a fill of any
        // size has to reach past the wallet to be paid.
        vm.startPrank(owner);
        HelicoAccount(payable(account)).permitVenue(AAVE_POOL, true);
        HelicoAccount(payable(account)).supplyIdle(AAVE_POOL, USDC, SUPPLIED_USDC);
        vm.stopPrank();

        deal(WETH, taker, 50e18);
        vm.prank(taker);
        IERC20(WETH).approve(address(router), type(uint256).max);
    }

    modifier onlyForked() {
        if (!forked) return;
        _;
    }

    // ── programs ──────────────────────────────────────────────────────────────

    function _concentrate() private pure returns (bytes memory) {
        return
            bytes.concat(bytes1(OP_CONCENTRATE), bytes1(uint8(64)), bytes32(SQRT_P_MIN), bytes32(SQRT_P_MAX));
    }

    function _swap() private pure returns (bytes memory) {
        return bytes.concat(bytes1(OP_SWAP), bytes1(uint8(0)));
    }

    function _cover() private view returns (bytes memory) {
        return
            bytes.concat(
                bytes1(uint8(router.AQUA_YIELD_COVER_OPCODE())), bytes1(uint8(20)), bytes20(AAVE_POOL)
            );
    }

    function _order(bytes memory program) private view returns (ISwapVM.Order memory) {
        return MakerTraitsLib.build(
            MakerTraitsLib.Args({
                maker: account,
                receiver: address(0),
                shouldUnwrapWeth: false,
                useAquaInsteadOfSignature: true,
                allowZeroAmountIn: false,
                hasPreTransferInHook: false,
                hasPostTransferInHook: false,
                hasPreTransferOutHook: false,
                hasPostTransferOutHook: false,
                preTransferInTarget: address(0),
                preTransferInData: "",
                postTransferInTarget: address(0),
                postTransferInData: "",
                preTransferOutTarget: address(0),
                preTransferOutData: "",
                postTransferOutTarget: address(0),
                postTransferOutData: "",
                program: program
            })
        );
    }

    /// @dev One owner signature's worth of work: three approvals and the ship, in one batch.
    function _ship(ISwapVM.Order memory order) private {
        address[] memory tokens = new address[](3);
        tokens[0] = USDC;
        tokens[1] = WETH;
        tokens[2] = AUSDC;

        uint256[] memory amounts = new uint256[](3);
        amounts[0] = COMMITTED_USDC;
        amounts[1] = COMMITTED_WETH;
        amounts[2] = IERC20(AUSDC).balanceOf(account);

        Call[] memory calls = new Call[](4);
        calls[0] = Call(USDC, 0, abi.encodeCall(IERC20.approve, (AQUA, type(uint256).max)));
        calls[1] = Call(WETH, 0, abi.encodeCall(IERC20.approve, (AQUA, type(uint256).max)));
        calls[2] = Call(AUSDC, 0, abi.encodeCall(IERC20.approve, (AQUA, type(uint256).max)));
        calls[3] =
            Call(AQUA, 0, abi.encodeCall(IAqua.ship, (address(router), abi.encode(order), tokens, amounts)));

        vm.prank(owner);
        HelicoAccount(payable(account)).executeBatch(calls);
    }

    function _takerData() private view returns (bytes memory) {
        return TakerTraitsLib.build(
            TakerTraitsLib.Args({
                taker: taker,
                isExactIn: true,
                shouldUnwrapWeth: false,
                isStrictThresholdAmount: false,
                isFirstTransferFromTaker: false,
                useTransferFromAndAquaPush: true,
                threshold: "",
                to: taker,
                deadline: 0,
                hasPreTransferInCallback: false,
                hasPreTransferOutCallback: false,
                preTransferInHookData: "",
                postTransferInHookData: "",
                preTransferOutHookData: "",
                postTransferOutHookData: "",
                preTransferInCallbackData: "",
                preTransferOutCallbackData: "",
                instructionsArgs: "",
                signature: ""
            })
        );
    }

    // ── the answers ───────────────────────────────────────────────────────────

    /// @dev The composition, and the only ordering that can hold: the band is opened, the swap is
    ///      priced against it, and the shortfall is unwound from Aave to pay it.
    function test_ABandIsPricedAndPaidOutOfCapitalStillEarning() public onlyForked {
        ISwapVM.Order memory order = _order(bytes.concat(_concentrate(), _swap(), _cover()));
        _ship(order);

        uint256 liquidBefore = IERC20(USDC).balanceOf(account);
        uint256 suppliedBefore = IERC20(AUSDC).balanceOf(account);
        assertLt(liquidBefore, 6_000e6, "the account is deliberately short of cash");

        vm.prank(taker);
        (, uint256 amountOut,) = router.swap(order, WETH, USDC, 5e18, _takerData());

        assertGt(amountOut, liquidBefore, "the fill paid more than the wallet held");
        assertEq(IERC20(USDC).balanceOf(taker), amountOut, "the taker was paid, on chain");
        assertLt(IERC20(AUSDC).balanceOf(account), suppliedBefore, "the lending position paid for it");

        emit log_named_uint("liquid before   ", liquidBefore);
        emit log_named_uint("supplied before ", suppliedBefore);
        emit log_named_uint("paid to taker   ", amountOut);
        emit log_named_uint("supplied after  ", IERC20(AUSDC).balanceOf(account));
    }

    /// @dev And the band is not decoration. The same trade against the same balances without the
    ///      concentrate instruction pays a different, worse price — which is the whole point of a
    ///      band, and the only way to tell a working composition from one where the first
    ///      instruction quietly did nothing.
    function test_TheBandChangesThePriceRatherThanDecoratingIt() public onlyForked {
        ISwapVM.Order memory banded = _order(bytes.concat(_concentrate(), _swap(), _cover()));
        _ship(banded);
        vm.prank(taker);
        (, uint256 withBand,) = router.swap(banded, WETH, USDC, 5e18, _takerData());

        // A second account, identical in every way except the program.
        address owner2 = makeAddr("plain-owner");
        address account2 = factory.accountFor(owner2);
        factory.open(owner2);
        vm.prank(USDC_WHALE);
        IERC20(USDC).transfer(account2, COMMITTED_USDC);
        deal(WETH, account2, COMMITTED_WETH);
        vm.startPrank(owner2);
        HelicoAccount(payable(account2)).permitVenue(AAVE_POOL, true);
        HelicoAccount(payable(account2)).supplyIdle(AAVE_POOL, USDC, SUPPLIED_USDC);
        vm.stopPrank();

        // `_order` and `_ship` both read the fields rather than taking arguments, because every
        // other test in this file has one account. Pointing them at the second one for two calls
        // is uglier than parameterising them and safer than a second copy of the ship batch,
        // which is the thing most likely to drift and quietly compare two different setups.
        address keep = account;
        address keepOwner = owner;
        account = account2;
        owner = owner2;
        ISwapVM.Order memory plain = _order(bytes.concat(_swap(), _cover()));
        _ship(plain);
        account = keep;
        owner = keepOwner;

        vm.prank(taker);
        (, uint256 withoutBand,) = router.swap(plain, WETH, USDC, 5e18, _takerData());

        assertTrue(withBand != withoutBand, "the band did nothing to the price");
        emit log_named_uint("with the band   ", withBand);
        emit log_named_uint("without it      ", withoutBand);
    }

    /// @dev The pairing #265 proposed, run rather than argued about — and the answer is better
    ///      than the one predicted here. It was expected to be silently inert, on the reasoning
    ///      that `_aquaYieldCoverXD` returns the moment it sees `amountOut == 0`. It does return,
    ///      but the program then reaches the end having priced nothing, and the taker traits
    ///      refuse a fill of zero.
    ///
    ///      So `[18][34]` announces itself rather than quietly carrying a cover that never runs.
    ///      Worth pinning precisely because the prediction was wrong: a two-instruction program
    ///      is not a weaker version of the composition, it is not a program at all.
    function test_TheTwoInstructionPairingIsRefusedRatherThanInert() public onlyForked {
        ISwapVM.Order memory order = _order(bytes.concat(_concentrate(), _cover()));
        _ship(order);

        vm.prank(taker);
        vm.expectRevert();
        router.swap(order, WETH, USDC, 1e18, _takerData());
    }

    /// @dev The other order, which Degensoft's own guard refuses outright. Worth pinning because
    ///      it is the one mistake of the three that announces itself.
    function test_ConcentrateAfterTheSwapIsRefusedByTheirOwnGuard() public onlyForked {
        ISwapVM.Order memory order = _order(bytes.concat(_swap(), _concentrate(), _cover()));
        _ship(order);

        vm.prank(taker);
        vm.expectRevert();
        router.swap(order, WETH, USDC, 5e18, _takerData());
    }
}
