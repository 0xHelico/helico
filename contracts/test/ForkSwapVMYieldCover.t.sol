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

/// @notice The question this file exists to answer: can 1inch's own swap engine settle a trade
///         out of capital that is still earning in Aave when the trade arrives?
///
/// @dev Everything here is live Arbitrum: the canonical Aqua, real USDC, real Aave, a real
///      supply position. The one contract that is ours is the router — Degensoft's
///      `AquaSwapVMRouter` redeployed with one added instruction, which their qualification
///      allows in as many words.
contract ForkSwapVMYieldCoverTest is Test {
    address constant AQUA = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;
    address constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    address constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
    address constant AAVE_POOL = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;
    address constant AUSDC = 0x724dc807b04555b71ed48a6896b6F41593b8C637;
    address constant USDC_WHALE = 0x47c031236e19d024b42f8AE6780E44A573170703;

    uint256 constant COMMITTED_USDC = 43_000e6;
    uint256 constant SUPPLIED_USDC = 38_000e6;
    uint256 constant COMMITTED_WETH = 20e18;

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

        owner = makeAddr("swapvm-owner");

        (, factory) = new DeployAccountFactory().deploy(address(0xC2E));
        // Through the deploy script rather than the constructor, so this suite exercises the
        // door production uses — including the script's own checks on the addresses it pins.
        router = new DeploySwapVMRouter().deploy(address(this));

        account = factory.accountFor(owner);
        factory.open(owner);

        vm.prank(USDC_WHALE);
        IERC20(USDC).transfer(account, COMMITTED_USDC);
        deal(WETH, account, COMMITTED_WETH);

        vm.startPrank(owner);
        HelicoAccount(payable(account)).permitVenue(AAVE_POOL, true);
        HelicoAccount(payable(account)).supplyIdle(AAVE_POOL, USDC, SUPPLIED_USDC);
        vm.stopPrank();
    }

    modifier onlyForked() {
        if (!forked) return;
        _;
    }

    /// @dev `[opcode][argsLength][args]`, which is what `runLoop` reads. Two instructions: the
    ///      constant-product curve 1inch published, then ours — in that order, because ours
    ///      reads the amount the curve computed.
    function _program() private view returns (bytes memory) {
        return bytes.concat(
            bytes1(uint8(17)), // XYCSwap._xycSwapXD — 18 in the source, minus one for the length word
            bytes1(uint8(0)),
            bytes1(uint8(router.AQUA_YIELD_COVER_OPCODE())),
            bytes1(uint8(20)),
            bytes20(AAVE_POOL)
        );
    }

    function _order() private view returns (ISwapVM.Order memory) {
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
                program: _program()
            })
        );
    }

    /// @dev One owner signature's worth of work: three approvals and the ship, in one batch.
    function _shipInOneBatch(ISwapVM.Order memory order) private {
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

    function test_SwapVMSettlesOutOfCapitalStillEarningInAave() public onlyForked {
        ISwapVM.Order memory order = _order();
        _shipInOneBatch(order);

        uint256 liquidBefore = IERC20(USDC).balanceOf(account);
        uint256 suppliedBefore = IERC20(AUSDC).balanceOf(account);
        assertLt(liquidBefore, 6_000e6, "the account is deliberately short of cash");

        deal(WETH, taker, 5e18);
        vm.startPrank(taker);
        IERC20(WETH).approve(address(router), type(uint256).max);
        (, uint256 amountOut,) = router.swap(order, WETH, USDC, 5e18, _takerData());
        vm.stopPrank();

        // The whole claim, in one comparison: the trade paid out more than the maker had.
        assertGt(amountOut, liquidBefore, "the swap paid more than the wallet held");
        assertEq(IERC20(USDC).balanceOf(taker), amountOut, "the taker was paid, on chain");
        assertLt(IERC20(AUSDC).balanceOf(account), suppliedBefore, "the position paid for it");

        emit log_named_uint("liquid before   ", liquidBefore);
        emit log_named_uint("supplied before ", suppliedBefore);
        emit log_named_uint("paid to taker   ", amountOut);
        emit log_named_uint("supplied after  ", IERC20(AUSDC).balanceOf(account));
    }

    /// @dev The branch the instruction takes on `isStaticContext`, which until this test was a
    ///      claim in a comment. `ISwapVM.quote` is declared `view`, so calling through the
    ///      interface is a `STATICCALL` — an instruction that writes anything on this path does
    ///      not return a worse number, it reverts, and every price the frontend asks for fails.
    function test_AQuoteIsAnsweredByAStaticCallAndMovesNothing() public onlyForked {
        ISwapVM.Order memory order = _order();
        _shipInOneBatch(order);

        uint256 suppliedBefore = IERC20(AUSDC).balanceOf(account);

        (, uint256 quoted,) = ISwapVM(address(router)).quote(order, WETH, USDC, 5e18, _takerData());

        assertEq(quoted, 8_600e6, "the quote priced against the committed balance, not the cash");
        assertGt(quoted, IERC20(USDC).balanceOf(account), "and quoted more than the wallet holds");
        assertEq(IERC20(AUSDC).balanceOf(account), suppliedBefore, "asking a price unwound nothing");
    }

    /// @dev The other half of the branch: a swap the wallet can already pay for must not touch
    ///      the lending position at all. A cover that unwinds anyway would cost the owner yield
    ///      on every trade, and nothing about the swap's result would show it.
    function test_TheCoverDoesNothingWhenTheWalletAlreadyHasEnough() public onlyForked {
        ISwapVM.Order memory order = _order();
        _shipInOneBatch(order);

        uint256 suppliedBefore = IERC20(AUSDC).balanceOf(account);

        deal(WETH, taker, 2e18);
        vm.startPrank(taker);
        IERC20(WETH).approve(address(router), type(uint256).max);
        (, uint256 amountOut,) = router.swap(order, WETH, USDC, 2e18, _takerData());
        vm.stopPrank();

        assertLt(amountOut, 5_000e6, "this trade is small enough for the cash on hand");
        assertEq(IERC20(USDC).balanceOf(taker), amountOut, "the taker was still paid");
        assertEq(IERC20(AUSDC).balanceOf(account), suppliedBefore, "and the position was left alone");
    }
}
