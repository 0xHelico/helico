// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice What a receipt token is, from the point of view of arithmetic.
///
/// @dev Only two shapes matter here, and the difference is whether one receipt unit is one
///      underlying unit:
///
///      - `Rebasing` — an Aave aToken. The balance itself grows, so the unit never drifts and a
///        withdrawal of `n` underlying burns `n` of the receipt. Every venue this project has
///        pointed at so far is this shape, which is why the assumption survived unnoticed.
///      - `SharePriced` — an ERC-4626 share, a Compound cToken. The unit price moves, so `n`
///        underlying is redeemed by some other number of shares. A seasoned cToken sits near
///        0.022, so treating the two as interchangeable is not a rounding error but two orders
///        of magnitude.
enum ReceiptKind {
    Rebasing,
    SharePriced
}

/// @notice The shares-per-assets question, asked of a share-priced receipt.
/// @dev `previewWithdraw` is the ERC-4626 accessor that answers *"how many shares must I burn to
///      receive exactly this many assets"*, and the standard requires it to round **up**. That is
///      the direction we want: pulling one share too many leaves dust that goes home, while
///      pulling one too few makes the withdrawal fall short and revert.
interface ISharePricedReceipt {
    function previewWithdraw(uint256 assets) external view returns (uint256 shares);
}

/// @title The conversion between a receipt and what it redeems for.
///
/// @dev **This exists because three contracts had the same wrong line.** `_cover` in
///      `HelicoMandateSwap` and `HelicoOracleBoard`, and `_aquaYieldCoverXD` in the SwapVM
///      router, all pulled `deficit` of the receipt and withdrew `deficit` of the underlying.
///      That is correct for a rebasing aToken and silently wrong for anything share-priced —
///      below par the withdrawal reverts, above par the mandate's receipt budget drains faster
///      than the position does, and nothing says so.
///
///      Raised in the venue audit and left open deliberately (#179): `ILendingVenue` is
///      Aave-shaped, so the assumption held for everything it could point at. It stops holding
///      the day a share-priced venue is added, which is what this makes safe.
///
///      One library rather than three copies, for the same reason `Venue` is imported rather
///      than redeclared: the copy that drifts would be the one a maker had already shipped.
library ReceiptMath {
    /// @notice How many receipt units redeem to at least `assets` of the underlying.
    /// @param kind What shape the receipt is. `Rebasing` is the identity, and costs no call.
    /// @param receipt The receipt token. Only read when `kind` is `SharePriced`.
    /// @param assets The amount of underlying that has to come out.
    function sharesFor(ReceiptKind kind, address receipt, uint256 assets) internal view returns (uint256) {
        if (kind == ReceiptKind.Rebasing) return assets;
        return ISharePricedReceipt(receipt).previewWithdraw(assets);
    }
}
