// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IComet} from "./IComet.sol";

/// @title Compound v3, wearing the interface the rest of this repository already speaks.
///
/// @notice **Why this exists.** The enclave compares supply rates across the markets an owner
///         permitted and moves capital to the best one. Until now every market it could compare was
///         Aave-shaped, which makes it a market picker rather than a yield optimiser — the thing it
///         is supposed to be is a comparison *across protocols*.
///
/// @dev **The one line that made this hard, and it is a name rather than a shape.**
///
///          HelicoMandateSwap._requireReceiptFor:
///          require(IReceiptToken(receipt).UNDERLYING_ASSET_ADDRESS() == token, ...)
///
///      `UNDERLYING_ASSET_ADDRESS()` is how an Aave aToken spells it. Comet's base token spells it
///      `baseToken()`. Both apps carrying that line are deployed and neither is upgradeable, so a
///      Compound venue that needs them changed is a Compound venue that ships after a redeploy.
///
///      **The way through is that nothing requires the receipt to be a different contract from the
///      pool.** The app asks the pool which receipt it issues, and a pool is allowed to answer with
///      itself. So this contract is both: an `ILendingVenue` for the app to call, and the ERC-20
///      the app pulls through Aqua and burns.
///
///      That also settles the problem underneath. `_cover` pulls the receipt to the app and then
///      calls `withdraw`, expecting the market to burn the *caller's* receipt with no approval in
///      between. Aave gets that because its Pool owns the aToken. This gets it by **being** the
///      token — `_burn(msg.sender, ...)` needs nobody's permission.
///
///      **Why not simply pull `cUSDCv3` itself**, which is the first thing to try and the question
///      this design should answer out loud. Compound v3 has no separate receipt contract — the
///      Comet market *is* the position — but that position is a transferable ERC-20 all the same
///      (`totalSupply`, `balanceOf`, `allowance` and `transfer` all answer on Arbitrum One), so
///      Aqua could move it. Two things stop it, and neither is the absence of a token:
///
///        1. Comet reverts on `UNDERLYING_ASSET_ADDRESS()`. `_requireReceiptFor` calls that on the
///           receipt, so the venue is refused before any arithmetic runs.
///        2. Burn authority. With `cUSDCv3` as the receipt, the app would hold the Comet position
///           and this adapter would have to spend it — but `withdrawTo` acts on **its own** balance,
///           so it would need `comet.allow(adapter, true)` from the app, and the deployed app has
///           no call that could grant it.
///
///      **Share-priced, deliberately.** Shares are fixed and the backing grows, so a share redeems
///      more of the asset over time and `ReceiptKind.SharePriced` converts through `previewWithdraw`.
///      A rebasing receipt was the alternative and is worse here: it needs an index of its own, and
///      an index that disagrees with Comet's by one wei is a hole.
///
///      **What this contract is not.** It is not a vault anyone should deposit into for its own
///      sake — there is no fee, no owner, no pause, and no upgrade. It holds one Comet position and
///      divides it, and every function on it is one an account or an Aqua app calls.
contract CompoundVenue is ERC20 {
    using SafeERC20 for IERC20;

    /// @dev A year in seconds, Compound's own constant. Only used to turn a per-second rate into
    ///      the annual one Aave reports, so the enclave compares two numbers of the same kind.
    uint256 private constant SECONDS_PER_YEAR = 60 * 60 * 24 * 365;

    /// @dev Aave reports rates in ray (1e27); Comet reports per-second in 1e18. Multiplying by the
    ///      seconds in a year takes 1e18-per-second to 1e18-per-year, and `1e9` finishes the scale.
    uint256 private constant WAD_TO_RAY = 1e9;

    IComet public immutable COMET;

    /// @notice The token this venue takes and returns. Comet's `baseToken`, read once at deploy.
    address public immutable ASSET;

    error WrongAsset(address asked, address expected);
    error NothingToSupply();
    error NothingToWithdraw();

    constructor(IComet comet)
        ERC20(
            string.concat("Helico Compound ", IERC20Metadata(comet.baseToken()).symbol()),
            string.concat("hc", IERC20Metadata(comet.baseToken()).symbol())
        )
    {
        COMET = comet;
        ASSET = comet.baseToken();
    }

    /// @dev The receipt and the asset share a unit count, so a caller reading `decimals` on either
    ///      gets a number that means the same thing. Diverging from the asset would make every
    ///      hand-checked figure in a test wrong in a way that still compiles.
    function decimals() public view override returns (uint8) {
        return IERC20Metadata(ASSET).decimals();
    }

    // ── the receipt half ──────────────────────────────────────────────────────

    /// @notice Aave's spelling, answered by a Compound venue. This is the whole point of the file.
    /// @dev `HelicoMandateSwap` and `HelicoOracleBoard` both call this on the receipt before they
    ///      will touch a venue, and a contract that cannot answer it is refused rather than trusted.
    function UNDERLYING_ASSET_ADDRESS() external view returns (address) {
        return ASSET;
    }

    /// @notice What this venue's whole position is worth right now, interest included.
    function totalAssets() public view returns (uint256) {
        return COMET.balanceOf(address(this));
    }

    /// @notice How many shares redeem for exactly `assets`, rounded **up**.
    /// @dev Up, because the app pulls this many and then asks for `assets` back. Rounding down
    ///      pulls one share too few and the withdrawal falls a wei short — which surfaces as a
    ///      revert from inside Comet, not as anything a reader could diagnose.
    ///
    ///      The `+1` on each side is the virtual-offset form. It makes the first deposit cost a
    ///      sane number of shares and makes a donation into an empty venue unprofitable, without a
    ///      minimum deposit — a minimum is a number somebody has to choose and then defend.
    function previewWithdraw(uint256 assets) public view returns (uint256) {
        uint256 supply_ = totalSupply();
        uint256 assets_ = totalAssets();
        return (assets * (supply_ + 1) + assets_) / (assets_ + 1);
    }

    /// @notice What `shares` are worth, rounded down. The inverse of `previewWithdraw`.
    function previewRedeem(uint256 shares) public view returns (uint256) {
        return shares * (totalAssets() + 1) / (totalSupply() + 1);
    }

    // ── the ILendingVenue half ────────────────────────────────────────────────

    /// @notice The receipt this market issues for `asset`, which is this contract.
    /// @dev The app asks the *pool* rather than the receipt, deliberately — a receipt is a contract
    ///      the maker names, so anything it says about itself is something the maker could have made
    ///      up. Here the two are one address, and the check still does its job: a forged receipt
    ///      claiming to belong to this venue does not equal `address(this)`.
    function getReserveAToken(address asset) external view returns (address) {
        require(asset == ASSET, WrongAsset(asset, ASSET));
        return address(this);
    }

    /// @notice Deposit `amount` of `asset` and credit the shares to `onBehalfOf`.
    /// @dev Aave's four-argument signature, referral code included and ignored, because this is the
    ///      shape `HelicoAccount.supplyIdle` calls and that contract is deployed.
    ///
    ///      Shares are computed **before** the supply lands, or the depositor would be paying for
    ///      backing they themselves just added.
    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external {
        require(asset == ASSET, WrongAsset(asset, ASSET));
        require(amount > 0, NothingToSupply());

        uint256 shares = amount * (totalSupply() + 1) / (totalAssets() + 1);

        IERC20(ASSET).safeTransferFrom(msg.sender, address(this), amount);
        IERC20(ASSET).forceApprove(address(COMET), amount);
        COMET.supply(ASSET, amount);

        _mint(onBehalfOf, shares);
    }

    /// @notice Burn the caller's shares and send `amount` of `asset` to `to`.
    /// @dev Returns exactly `amount` or reverts, which is what `ILendingVenue` promises and what
    ///      `_cover` measures against.
    ///
    ///      `_burn(msg.sender, ...)` is the line the whole design exists for: no allowance is
    ///      consulted because this contract is the token, so the app that just received the shares
    ///      through Aqua can spend them in the same call.
    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        require(asset == ASSET, WrongAsset(asset, ASSET));
        require(amount > 0, NothingToWithdraw());

        _burn(msg.sender, previewWithdraw(amount));
        COMET.withdrawTo(to, ASSET, amount);
        return amount;
    }

    /// @notice What this venue can actually pay out right now.
    /// @dev Two ceilings, and the lower one binds. The market may hold plenty and this venue hold
    ///      almost none of it, or the reverse. Reporting either alone turns a venue that cannot pay
    ///      into the answer a search stops at.
    function getVirtualUnderlyingBalance(address asset) external view returns (uint128) {
        require(asset == ASSET, WrongAsset(asset, ASSET));
        uint256 inMarket = IERC20(ASSET).balanceOf(address(COMET));
        uint256 ours = totalAssets();
        return uint128(inMarket < ours ? inMarket : ours);
    }

    /// @notice The maker owes this venue nothing, and never can.
    ///
    /// @dev The guard this answers — `_requireNoDebt` — exists because unwinding collateral that
    ///      backs a loan can liquidate the borrower, and the market's own health checks do not run
    ///      for us. Here there is nothing to check: this venue only ever supplies, the Comet
    ///      position belongs to **this contract** rather than to the maker, and a borrow the maker
    ///      has taken out on Comet themselves is a different account that this withdrawal does not
    ///      touch. Returning a real `borrowBalanceOf(maker)` would refuse makers for a position
    ///      that has nothing to do with the one being unwound.
    ///
    ///      Aave's tuple shape, because that is what the deployed apps decode.
    function getUserAccountData(address)
        external
        pure
        returns (uint256, uint256, uint256, uint256, uint256, uint256)
    {
        return (0, 0, 0, 0, 0, type(uint256).max);
    }

    /// @notice Aave's reserve tuple, carrying the one field the enclave reads.
    /// @dev `currentLiquidityRate` is the second member, and the workflow decodes the whole struct
    ///      to reach it. Comet answers a **per-second** rate scaled by 1e18; Aave reports an annual
    ///      ray. Both conversions happen here so the enclave compares two numbers of one kind, and
    ///      neither the workflow nor the decision has to know which protocol answered.
    ///
    ///      `aTokenAddress` is this contract, matching `getReserveAToken` — the workflow reads the
    ///      receipt from both and a disagreement would be a venue it silently skips.
    function getReserveData(address asset) external view returns (ReserveData memory data) {
        require(asset == ASSET, WrongAsset(asset, ASSET));
        uint256 perSecond = COMET.getSupplyRate(COMET.getUtilization());
        data.currentLiquidityRate = uint128(perSecond * SECONDS_PER_YEAR * WAD_TO_RAY);
        data.aTokenAddress = address(this);
        data.lastUpdateTimestamp = uint40(block.timestamp);
    }
}

/// @notice The tuple `getReserveData` answers with, field for field as Aave v3 declares it.
/// @dev Declared here rather than imported: the app never reads it, only the workflow does, and a
///      struct this file owns cannot drift out from under the one place that fills it.
struct ReserveData {
    uint256 configuration;
    uint128 liquidityIndex;
    uint128 currentLiquidityRate;
    uint128 variableBorrowIndex;
    uint128 currentVariableBorrowRate;
    uint128 currentStableBorrowRate;
    uint40 lastUpdateTimestamp;
    uint16 id;
    address aTokenAddress;
    address stableDebtTokenAddress;
    address variableDebtTokenAddress;
    address interestRateStrategyAddress;
    uint128 accruedToTreasury;
    uint128 unbacked;
    uint128 isolationModeTotalDebt;
}

interface IERC20Metadata {
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
}
