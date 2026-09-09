// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IERC4626Vault} from "./IERC4626Vault.sol";
import {ReserveData} from "./CompoundVenue.sol";

/// @title A Morpho vault, wearing the interface the rest of this repository already speaks.
///
/// @notice The second venue outside the Aave family, and it is here for the same reason as the
///         first: an enclave that ranks markets inside one protocol is a market picker. `MorphoVenue`
///         is written against **ERC-4626** rather than against Morpho, so a MetaMorpho vault is the
///         first thing it is pointed at and not the only thing it could be.
///
/// @dev **What it shares with `CompoundVenue`, deliberately rather than by accident.** The venue is
///      its own receipt. `_requireReceiptFor` in both deployed Aqua apps asks the receipt for
///      `UNDERLYING_ASSET_ADDRESS()` — Aave's aToken spelling, which a 4626 vault answers as
///      `asset()` — and `_cover` expects the market to burn the **caller's** receipt with no
///      approval in between. Being the token settles both.
///
///      The two contracts are not factored into a common base on purpose. They are separate
///      deployments for separate protocols and never have to agree with each other, only each with
///      itself — unlike `Venue`, which is one struct two apps decode and is therefore imported
///      rather than redeclared.
///
///      **What is genuinely different, and it is the hard part: Morpho has no rate function.**
///      Aave reports `currentLiquidityRate`; Comet reports `getSupplyRate`. A MetaMorpho vault
///      reports nothing — the APY on Morpho's own front end comes from their API, not from the
///      chain. A vault spreads across markets (this one across nine) each with its own IRM and a
///      fee on top, so a forward-looking rate would be a weighted reconstruction of numbers the
///      vault does not publish.
///
///      So this reports a **trailing realised** rate instead: what the share price actually did
///      between two observations, annualised. That is a different claim from an instantaneous one
///      and arguably a better one — it is measured rather than modelled, and it already contains
///      the fee. `lastUpdateTimestamp` in the reserve tuple carries how old the baseline is, so a
///      reader can see the window rather than having to trust it.
///
///      The sample is taken at `convertToAssets(1e27)` rather than `1e18`, and the probe size is
///      load-bearing. At `1e18` the price of this vault is about `1.04e6` and five minutes of a 4%
///      yield moves it by **less than one unit** — the rate would read zero forever, correctly
///      computed and useless. At `1e27` the same five minutes move it by `4.36e8`.
contract MorphoVenue is ERC20 {
    using SafeERC20 for IERC20;

    uint256 private constant SECONDS_PER_YEAR = 365 days;
    uint256 private constant RAY = 1e27;

    /// @dev The probe. See the note above on why it is this large.
    uint256 private constant PRICE_PROBE = 1e27;

    /// @dev Below this, two observations are too close together to say anything. Not a precision
    ///      floor — the probe handles that — but a noise floor: a single block's rounding should
    ///      not be annualised into a number the enclave acts on.
    uint256 private constant MIN_WINDOW = 60;

    IERC4626Vault public immutable VAULT;
    address public immutable ASSET;

    /// @notice `convertToAssets(PRICE_PROBE)` when the rate was last computed.
    uint256 public sampledPrice;

    /// @notice When that sample was taken. Also what `getReserveData` reports as its update time.
    uint40 public sampledAt;

    /// @notice The trailing realised rate, annualised, in Aave's ray. Zero until a window has passed.
    uint128 public sampledRateRay;

    error WrongAsset(address asked, address expected);
    error NothingToSupply();
    error NothingToWithdraw();

    event RateSampled(uint256 price, uint128 rateRay, uint256 window);

    constructor(IERC4626Vault vault)
        ERC20(
            string.concat("Helico Morpho ", IERC20Metadata(vault.asset()).symbol()),
            string.concat("hm", IERC20Metadata(vault.asset()).symbol())
        )
    {
        VAULT = vault;
        ASSET = vault.asset();
        sampledPrice = vault.convertToAssets(PRICE_PROBE);
        sampledAt = uint40(block.timestamp);
    }

    /// @dev This venue's shares count in the **asset's** units, not the vault's. A MetaMorpho vault
    ///      has eighteen decimals over a six-decimal asset, and a receipt whose scale disagrees with
    ///      the token it redeems for makes every hand-checked figure in a test wrong in a way that
    ///      still compiles.
    function decimals() public view override returns (uint8) {
        return IERC20Metadata(ASSET).decimals();
    }

    // ── the receipt half ──────────────────────────────────────────────────────

    /// @notice Aave's spelling, answered by a Morpho venue. One `require` in two deployed contracts
    ///         is the entire reason this file is shaped the way it is.
    function UNDERLYING_ASSET_ADDRESS() external view returns (address) {
        return ASSET;
    }

    /// @notice What this venue's whole position in the vault is worth right now.
    function totalAssets() public view returns (uint256) {
        return VAULT.convertToAssets(VAULT.balanceOf(address(this)));
    }

    /// @notice How many of this venue's shares redeem for exactly `assets`, rounded **up**.
    /// @dev Up, and against the redeemer, for the reason `CompoundVenue` gives: the app pulls this
    ///      many and then asks for `assets` back, so rounding down falls a wei short inside the
    ///      vault where nothing can explain it. `+1` on each side is the virtual-offset form.
    function previewWithdraw(uint256 assets) public view returns (uint256) {
        uint256 supply_ = totalSupply();
        uint256 assets_ = totalAssets();
        return (assets * (supply_ + 1) + assets_) / (assets_ + 1);
    }

    /// @notice What `shares` are worth, rounded down. The inverse of `previewWithdraw`.
    function previewRedeem(uint256 shares) public view returns (uint256) {
        return shares * (totalAssets() + 1) / (totalSupply() + 1);
    }

    // ── the rate ──────────────────────────────────────────────────────────────

    /// @notice Take a new observation of the vault's share price and recompute the trailing rate.
    ///
    /// @dev Permissionless and idempotent. Called on every `supply` and `withdraw` so an active
    ///      venue keeps itself current, and callable on its own so a quiet one can be refreshed by
    ///      anyone — including the agent, on the tick it is already awake for.
    ///
    ///      A price that fell reports **zero** rather than reverting or wrapping. A vault can lose
    ///      money, and a venue that cannot express that would be a venue that only ever looks good.
    function poke() public {
        uint256 price = VAULT.convertToAssets(PRICE_PROBE);
        uint256 window = block.timestamp - sampledAt;
        if (window < MIN_WINDOW || sampledPrice == 0) return;

        uint128 rate = 0;
        if (price > sampledPrice) {
            rate = uint128((price - sampledPrice) * RAY * SECONDS_PER_YEAR / (sampledPrice * window));
        }

        sampledRateRay = rate;
        sampledPrice = price;
        sampledAt = uint40(block.timestamp);
        emit RateSampled(price, rate, window);
    }

    // ── the ILendingVenue half ────────────────────────────────────────────────

    /// @notice The receipt this market issues for `asset`, which is this contract.
    function getReserveAToken(address asset) external view returns (address) {
        require(asset == ASSET, WrongAsset(asset, ASSET));
        return address(this);
    }

    /// @notice Deposit `amount` of `asset` into the vault and credit the shares to `onBehalfOf`.
    /// @dev Aave's four-argument signature, referral code accepted and ignored, because that is the
    ///      shape `HelicoAccount.supplyIdle` calls and that contract is deployed.
    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external {
        require(asset == ASSET, WrongAsset(asset, ASSET));
        require(amount > 0, NothingToSupply());

        uint256 shares = amount * (totalSupply() + 1) / (totalAssets() + 1);

        IERC20(ASSET).safeTransferFrom(msg.sender, address(this), amount);
        IERC20(ASSET).forceApprove(address(VAULT), amount);
        VAULT.deposit(amount, address(this));

        _mint(onBehalfOf, shares);
        poke();
    }

    /// @notice Burn the caller's shares and send `amount` of `asset` to `to`.
    /// @dev `_burn(msg.sender, …)` consults no allowance, because this contract is the token. That
    ///      is what lets the app spend shares it received through Aqua in the same call.
    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        require(asset == ASSET, WrongAsset(asset, ASSET));
        require(amount > 0, NothingToWithdraw());

        _burn(msg.sender, previewWithdraw(amount));
        VAULT.withdraw(amount, to, address(this));
        poke();
        return amount;
    }

    /// @notice What this venue can actually pay out right now.
    /// @dev `maxWithdraw` rather than the vault's token balance. A MetaMorpho vault holds almost
    ///      nothing idle — the one this was written against held 10,000 wei against 2.4M supplied —
    ///      so a balance read would report a venue that cannot pay as one that can, and the search
    ///      would stop at it.
    function getVirtualUnderlyingBalance(address asset) external view returns (uint128) {
        require(asset == ASSET, WrongAsset(asset, ASSET));
        uint256 fromVault = VAULT.maxWithdraw(address(this));
        uint256 ours = totalAssets();
        return uint128(fromVault < ours ? fromVault : ours);
    }

    /// @notice The maker owes this venue nothing, and never can.
    /// @dev The guard this answers exists because unwinding collateral that backs a loan can
    ///      liquidate the borrower. This venue only ever deposits, the vault position belongs to
    ///      **this contract** rather than to the maker, and a loan the maker has taken out on
    ///      Morpho themselves is a different account this withdrawal does not touch.
    function getUserAccountData(address)
        external
        pure
        returns (uint256, uint256, uint256, uint256, uint256, uint256)
    {
        return (0, 0, 0, 0, 0, type(uint256).max);
    }

    /// @notice Aave's reserve tuple, carrying the trailing realised rate.
    /// @dev `lastUpdateTimestamp` is the age of the observation rather than of the block, so a
    ///      reader can tell a fresh rate from one nobody has refreshed. That distinction is the
    ///      whole reason this venue is allowed to report a measured number at all.
    function getReserveData(address asset) external view returns (ReserveData memory data) {
        require(asset == ASSET, WrongAsset(asset, ASSET));
        data.currentLiquidityRate = sampledRateRay;
        data.aTokenAddress = address(this);
        data.lastUpdateTimestamp = sampledAt;
    }
}

interface IERC20Metadata {
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
}
