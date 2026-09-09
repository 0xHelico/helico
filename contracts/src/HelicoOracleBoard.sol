// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AquaApp} from "@1inch/aqua/AquaApp.sol";
import {IAqua} from "@1inch/aqua/interfaces/IAqua.sol";

import {ILendingVenue} from "./ILendingVenue.sol";
// The same struct `HelicoMandateSwap` uses, imported rather than redeclared: two definitions of
// a venue would drift, and the one that drifted would be the one a maker had already shipped.
// `receipt0` is the receipt for `quote`, `receipt1` the receipt for `base`.
import {Venue} from "./HelicoMandateSwap.sol";

/// @notice The taker's half of a fill: pay for what the board already handed over.
/// @dev Four arguments rather than the eight `IHelicoMandateSwapCallback` carries. A taker that
///      needs the rest can read it from the board they passed in, and every argument here is one
///      more slot in a frame that has already overflowed once.
interface IHelicoOracleBoardCallback {
    function helicoOracleBoardCallback(address tokenIn, uint256 amountIn, address maker, bytes32 hash)
        external;
}

/// @notice The slice of Chainlink's aggregator this app reads.
interface IPriceFeed {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @title An Aqua app that quotes from a price feed and bends the quote with its own inventory.
///
/// @notice **Why this exists next to `HelicoMandateSwap`.** That app prices from a constant
///         product, which has one property we want and one we cannot live with here. The property
///         we want is that it brakes itself: every fill moves the reserves, so the price walks
///         away from whoever keeps taking the same side. The property we cannot live with is that
///         the price *is* the ratio of two balances — so a maker holding one token has no price
///         at all, and `HelicoMandateSwap` rightly refuses them with `DegenerateReserves`.
///
///         A maker who holds only USDC is exactly the maker this project is built for: their
///         capital can sit in a lending market earning, and a fill is settled out of it. Telling
///         them to hold ETH as well to be quotable undoes the point.
///
///         So the price here comes from a feed, and the braking comes from somewhere else.
///
/// @dev **How the quote is built, in three steps.**
///
///      1. `mid` — the feed's answer, rescaled into quote units per `1e18` of base. Refused if
///         it is stale or non-positive, because a board quoting yesterday's price is a board
///         being taken from.
///      2. `skew` — how far through `baseCap` the maker's base inventory already is, read from
///         **Aqua's own ledger** rather than from the wallet. The ledger is the mandate's
///         accounting; a wallet balance would also count tokens that belong to other strategies.
///      3. Both sides are shifted **down** by the skew:
///
///             bid = mid * (BPS - spread - skew) / BPS      the maker buying base
///             ask = mid * (BPS + spread - skew) / BPS      the maker selling base
///
///      Shifting both down is what makes it self-braking. With an empty inventory the quotes sit
///      symmetrically around the feed. As base accumulates the bid falls, so selling into this
///      board gets steadily worse — and the ask falls with it, so buying the inventory back gets
///      steadily better. Inventory is pushed back toward zero by the price rather than by anyone
///      watching. That is the behaviour a constant product gets for free, restored on top of a
///      feed that knows nothing about who holds what.
///
///      `baseCap` is also a hard ceiling, not only the scale of the skew. Skew alone bends the
///      price but never refuses, and a price that is merely bad is one somebody will still take
///      if the market has moved enough.
///
///      **What this does not do.** It has no view on whether the feed is right. A feed that is
///      manipulated inside its heartbeat is a loss here, exactly as it would be for anything else
///      quoting from it, and the spread is the only cushion.
contract HelicoOracleBoard is AquaApp {
    uint256 private constant BPS = 10_000;

    /// @param maker Whose wallet both sides come from. Aqua keys balances by the shipping
    ///        address and never checks the bytes agree, so the app must carry it.
    /// @param quote The token the maker starts with — USDC in the case this was built for.
    /// @param base The token priced by the feed. May be shipped with an amount of zero.
    /// @param feed A Chainlink aggregator answering base-in-quote.
    /// @param maxStaleness Seconds after `updatedAt` at which the feed stops being usable.
    /// @param spreadBps Half-spread around the feed, kept by the maker. The only earnings here.
    /// @param maxSkewBps How far the quote bends when inventory reaches `baseCap`.
    /// @param baseCap Base units at which the skew is full, and past which buying is refused.
    /// @param expiry First timestamp at which the board is dead.
    /// @param app Must be this contract, so a board cannot be replayed against another app.
    /// @param venues Lending markets this board may unwind to cover a fill, with the receipt
    ///        token each returns for each side. Empty means the wallet is the only source, which
    ///        is the behaviour this app had before venues existed.
    /// @param salt Lets the same terms be shipped twice, since Aqua keys everything by hash.
    struct Board {
        address maker;
        address quote;
        address base;
        address feed;
        uint256 maxStaleness;
        uint256 spreadBps;
        uint256 maxSkewBps;
        uint256 baseCap;
        uint256 expiry;
        Venue[] venues;
        address app;
        bytes32 salt;
    }

    error WrongApp(address named, address actual);
    error BoardExpired(uint256 expiry, uint256 nowTs);
    error FeedStale(uint256 updatedAt, uint256 nowTs, uint256 maxStaleness);
    error FeedNotPositive(int256 answer);
    error SpreadTooWide(uint256 spreadBps, uint256 maxSkewBps);
    error CapWouldBeExceeded(uint256 held, uint256 amountIn, uint256 baseCap);
    error NotEnoughOnTheBoard(uint256 wanted, uint256 available);
    error InsufficientOutputAmount(uint256 amountOut, uint256 amountOutMin);
    error IdenticalTokens(address token);
    error ZeroAmount();
    error NoVenueCanCover(address token, uint256 deficit);
    error MakerHasDebt(address maker, uint256 debt);
    error ReceiptRetained(address receipt, uint256 held);
    error UnwindFellShort(address token, uint256 held, uint256 needed);
    error ReceiptAliasesReserve(address token);

    event Filled(
        address indexed maker, address indexed taker, bool takerSoldBase, uint256 amountIn, uint256 amountOut
    );

    constructor(IAqua aqua) AquaApp(aqua) {}

    function hashOf(Board calldata board) public pure returns (bytes32) {
        return keccak256(abi.encode(board));
    }

    /// @notice The two quotes this board is currently showing, in quote units per `1e18` base.
    /// @dev Public because a maker who cannot see their own board cannot tell whether it is about
    ///      to be taken from, and because the frontend needs the same numbers the fill will use.
    function quotes(Board calldata board) public view returns (uint256 bid, uint256 ask) {
        uint256 mid = _mid(board);
        uint256 skew = _skewBps(board);
        bid = mid * (BPS - board.spreadBps - skew) / BPS;
        ask = mid * (BPS + board.spreadBps - skew) / BPS;
    }

    /// @notice What a fill would pay, without moving anything.
    /// @param takerSellsBase True when the taker hands over base and receives quote.
    function quoteExactIn(Board calldata board, bool takerSellsBase, uint256 amountIn)
        public
        view
        returns (uint256 amountOut)
    {
        _check(board);
        (uint256 bid, uint256 ask) = quotes(board);
        amountOut = takerSellsBase ? amountIn * bid / 1e18 : amountIn * 1e18 / ask;
    }

    /// @notice Fill against the board. The taker is called back to pay for what they were handed.
    /// @dev The order is the protocol's: `pull` first, then the callback, then
    ///      `_safeCheckAquaPush` proves the taker paid. The taker is trusted for the length of one
    ///      callback and no longer.
    function fill(
        Board calldata board,
        bool takerSellsBase,
        uint256 amountIn,
        uint256 amountOutMin,
        address to
    ) external nonReentrantStrategy(board.maker, hashOf(board)) returns (uint256 amountOut) {
        require(amountIn > 0, ZeroAmount());
        _check(board);

        uint256 pushedBack;
        (amountOut, pushedBack) = _priceAndBudget(board, hashOf(board), takerSellsBase, amountIn);
        require(amountOut >= amountOutMin, InsufficientOutputAmount(amountOut, amountOutMin));

        _settle(board, takerSellsBase, amountIn, amountOut, pushedBack, to);

        emit Filled(board.maker, msg.sender, takerSellsBase, amountIn, amountOut);
    }

    /// @dev Hand over, call back, then prove the taker paid. Split out of `fill` because the
    ///      board, the hash, both token addresses and the amounts do not fit in one frame.
    function _settle(
        Board calldata board,
        bool takerSellsBase,
        uint256 amountIn,
        uint256 amountOut,
        uint256 pushedBack,
        address to
    ) private {
        bytes32 hash = hashOf(board);
        address tokenIn = takerSellsBase ? board.base : board.quote;
        address tokenOut = takerSellsBase ? board.quote : board.base;

        _cover(board, hash, tokenOut, amountOut);
        AQUA.pull(board.maker, hash, tokenOut, amountOut, to);
        IHelicoOracleBoardCallback(msg.sender).helicoOracleBoardCallback(tokenIn, amountIn, board.maker, hash);
        _safeCheckAquaPush(board.maker, hash, tokenIn, pushedBack + amountIn);
    }

    // ── settling out of a lending market ──────────────────────────────────────

    /// @dev Top the maker's wallet up from a lending market, and only by what is missing.
    ///
    ///      **The wallet is spent first, always.** A maker with enough sitting idle never touches
    ///      a market at all, so a market being paused or illiquid cannot break a fill that did not
    ///      need it. That is not an optimisation — it is what keeps a dependency this app added
    ///      from reaching fills that do not depend on it.
    ///
    ///      This is `HelicoMandateSwap._cover`, and it is here because the maker this app exists
    ///      for is precisely the one whose capital is not in their wallet. A one-sided board
    ///      without it quotes a price it cannot honour.
    function _cover(Board calldata board, bytes32 hash, address tokenOut, uint256 amountOut) private {
        if (board.venues.length == 0) return;

        uint256 held = IERC20(tokenOut).balanceOf(board.maker);
        if (held >= amountOut) return;
        uint256 deficit = amountOut - held;

        (uint256 index, address receipt) = _venueFor(board, hash, tokenOut, deficit);
        _requireNoDebt(board.venues[index].pool, board.maker);

        // What this contract held before the pull. Everything below is measured against it,
        // because a receipt left here by any earlier call belongs to somebody else. This must
        // stay a measurement: a maker-chosen pool is arbitrary code, called while this contract
        // holds receipts, so it can reenter — and the accounting only closes because each frame
        // measures its own starting point.
        uint256 beforePull = IERC20(receipt).balanceOf(address(this));

        AQUA.pull(board.maker, hash, receipt, deficit, address(this));

        // A named amount, never a sweep. A sweep burns whatever this contract holds rather than
        // what this fill pulled, which lets a small board redeem a large position that arrived
        // here some other way.
        ILendingVenue(board.venues[index].pool).withdraw(tokenOut, deficit, board.maker);

        // Any receipt the burn did not consume goes home. Rounding is the usual cause and the
        // amount is dust, but dust left here is dust the next caller can claim.
        uint256 heldNow = IERC20(receipt).balanceOf(address(this));
        if (heldNow > beforePull) {
            SafeERC20.safeTransfer(IERC20(receipt), board.maker, heldNow - beforePull);
            heldNow = IERC20(receipt).balanceOf(address(this));
        }
        require(heldNow == beforePull, ReceiptRetained(receipt, heldNow));

        uint256 nowHeld = IERC20(tokenOut).balanceOf(board.maker);
        require(nowHeld >= amountOut, UnwindFellShort(tokenOut, nowHeld, amountOut));
    }

    /// @dev The first venue that can actually pay this deficit. Three separate things must be
    ///      true and the market's own liquidity is only one of them: a venue can be deep and
    ///      still unable to pay *this* board, because the maker may hold no position there or the
    ///      board may have no receipt budget left for it. Checking only the first turns a venue
    ///      that cannot pay into the answer, ends the search, and strands a funded venue further
    ///      down the list — while the failure arrives as an arithmetic panic from inside Aqua
    ///      rather than as a refusal anyone can read. Skipping is what makes the list a list.
    function _venueFor(Board calldata board, bytes32 hash, address tokenOut, uint256 deficit)
        private
        view
        returns (uint256 index, address receipt)
    {
        bool quoteSide = tokenOut == board.quote;
        for (uint256 i = 0; i < board.venues.length; i++) {
            Venue calldata v = board.venues[i];
            address r = quoteSide ? v.receipt0 : v.receipt1;
            if (r == address(0)) continue;
            if (ILendingVenue(v.pool).getVirtualUnderlyingBalance(tokenOut) < deficit) continue;
            (uint248 budget,) = AQUA.rawBalances(board.maker, address(this), hash, r);
            if (budget < deficit) continue;
            if (IERC20(r).balanceOf(board.maker) < deficit) continue;
            return (i, r);
        }
        revert NoVenueCanCover(tokenOut, deficit);
    }

    /// @dev Unwinding a position that backs a loan can liquidate the maker. Aave's own health
    ///      checks do not run for us, so the refusal has to be here.
    function _requireNoDebt(address pool, address maker) private view {
        (, uint256 debt,,,,) = ILendingVenue(pool).getUserAccountData(maker);
        require(debt == 0, MakerHasDebt(maker, debt));
    }

    // ── internals ─────────────────────────────────────────────────────────────

    /// @dev Everything about the board itself that must hold before it may be quoted or filled.
    function _check(Board calldata board) private view {
        require(board.app == address(this), WrongApp(board.app, address(this)));
        require(board.base != board.quote, IdenticalTokens(board.base));
        require(block.timestamp < board.expiry, BoardExpired(board.expiry, block.timestamp));
        // Both quotes must stay strictly inside the feed. A spread wider than the bend would
        // underflow the ask; a bend wider than the spread would put the bid below zero.
        require(board.spreadBps + board.maxSkewBps < BPS, SpreadTooWide(board.spreadBps, board.maxSkewBps));
        // A receipt that is also one of the traded tokens makes the unwind spend the very reserve
        // it is trying to top up, taking the ledger down twice for one fill.
        for (uint256 i = 0; i < board.venues.length; i++) {
            address r0 = board.venues[i].receipt0;
            address r1 = board.venues[i].receipt1;
            require(r0 != board.quote && r0 != board.base, ReceiptAliasesReserve(r0));
            require(r1 != board.quote && r1 != board.base, ReceiptAliasesReserve(r1));
        }
    }

    /// @dev The feed, rescaled to quote units per `1e18` of base.
    function _mid(Board calldata board) private view returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = IPriceFeed(board.feed).latestRoundData();
        require(answer > 0, FeedNotPositive(answer));
        require(
            block.timestamp - updatedAt <= board.maxStaleness,
            FeedStale(updatedAt, block.timestamp, board.maxStaleness)
        );
        uint8 feedDecimals = IPriceFeed(board.feed).decimals();
        uint8 quoteDecimals = IERC20Decimals(board.quote).decimals();
        // A feed of 8 decimals answering 2_485_02954852 for a 6-decimal quote is 2485.029548
        // quote units, and the scaling is the whole difference between a right and a wrong price.
        return uint256(answer) * (10 ** quoteDecimals) / (10 ** feedDecimals);
    }

    /// @dev How far through `baseCap` the inventory already is, in basis points of `maxSkewBps`.
    ///      Read from Aqua's ledger, which is this mandate's own accounting.
    function _skewBps(Board calldata board) private view returns (uint256) {
        if (board.baseCap == 0) return 0;
        (, uint256 held) =
            AQUA.safeBalances(board.maker, address(this), hashOf(board), board.quote, board.base);
        if (held >= board.baseCap) return board.maxSkewBps;
        return board.maxSkewBps * held / board.baseCap;
    }

    /// @dev Split out of `fill` because the board, both quotes, both balances and the amounts do
    ///      not fit in one frame. Returns the outgoing amount and the incoming side's balance as
    ///      it was **before** the pull — reading it again afterwards would read a number the
    ///      callback could have moved.
    function _priceAndBudget(Board calldata board, bytes32 hash, bool takerSellsBase, uint256 amountIn)
        private
        view
        returns (uint256 amountOut, uint256 pushedBack)
    {
        (uint256 quoteHeld, uint256 baseHeld) =
            AQUA.safeBalances(board.maker, address(this), hash, board.quote, board.base);

        amountOut = quoteExactIn(board, takerSellsBase, amountIn);
        require(amountOut > 0, ZeroAmount());

        if (takerSellsBase) {
            // The maker is buying base. The cap refuses rather than merely discouraging, because
            // a bent price is still a price somebody takes once the market has moved enough.
            require(
                baseHeld + amountIn <= board.baseCap, CapWouldBeExceeded(baseHeld, amountIn, board.baseCap)
            );
            require(amountOut <= quoteHeld, NotEnoughOnTheBoard(amountOut, quoteHeld));
            pushedBack = baseHeld;
        } else {
            require(amountOut <= baseHeld, NotEnoughOnTheBoard(amountOut, baseHeld));
            pushedBack = quoteHeld;
        }
    }
}

/// @notice `decimals()` is not in the ERC-20 interface OpenZeppelin exposes here, and the price
///         is wrong by orders of magnitude without it.
interface IERC20Decimals {
    function decimals() external view returns (uint8);
}
