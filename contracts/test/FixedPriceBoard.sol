// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AquaApp} from "@1inch/aqua/AquaApp.sol";
import {IAqua} from "@1inch/aqua/interfaces/IAqua.sol";

/// @notice The taker's side of a fixed-price fill: pay for what was already handed over.
interface IFixedPriceBoardCallback {
    function fixedPriceBoardCallback(address buyToken, uint256 amountIn, address maker, bytes32 hash) external;
}

/// @title A maker's board, with the price written on it rather than computed from two balances.
///
/// @notice **This exists to answer one question and is not shipped.** `HelicoMandateSwap` prices
///         from a constant product, so it needs both sides of the pair to hold something —
///         `DegenerateReserves` refuses a zero side, because the curve would otherwise hand over
///         the whole opposite balance for two wei. That is a property of the curve we chose, and
///         the question it raises is whether one-sided liquidity is impossible in Aqua or merely
///         impossible in our app.
///
/// @dev Aqua does not price anything. The whole protocol is 81 lines of bookkeeping: `ship`
///      writes numbers and moves nothing, `pull` decrements and transfers from the maker's
///      wallet, `push` increments and transfers to it. No `price`, no `quote`, no curve appears
///      in it. So the pricing rule is the app's, and an app that reads its price from a field
///      rather than from a ratio has nothing to say about a zero balance.
///
///      What still binds, and is the interesting part: `Aqua.safeBalances` requires **both**
///      tokens to be in an active strategy —
///
///          require(tokensCount0 > 0 && tokensCount0 != _DOCKED, ...)
///
///      and `tokensCount` is set by `ship` from `tokens.length`, not from the amounts. So a
///      strategy that names only USDC leaves WETH with `tokensCount == 0`, and any read touching
///      WETH reverts. The way through is to **name both tokens and give one of them zero**:
///      `tokensCount` becomes 2 for both, the reads work, and the maker's capital is still 100%
///      USDC. `ForkOneSidedFixedPrice.t.sol` proves both halves of that.
contract FixedPriceBoard is AquaApp {
    /// @param maker Whose wallet the `sell` token comes from.
    /// @param sell The token the maker gives away. The only token they need to hold.
    /// @param buy The token the maker receives. Named in the strategy with an amount of zero.
    /// @param priceE18 How many `sell` units the maker pays for `1e18` units of `buy`.
    /// @param app Must be this contract, so a strategy cannot be replayed against another app.
    /// @param salt Lets the same terms be shipped twice, since Aqua keys everything by hash.
    struct Board {
        address maker;
        address sell;
        address buy;
        uint256 priceE18;
        address app;
        bytes32 salt;
    }

    error WrongApp(address app, address actual);
    error NotEnoughOnTheBoard(uint256 wanted, uint256 available);
    error NothingToSell();

    event Filled(address indexed maker, address indexed taker, uint256 amountIn, uint256 amountOut);

    constructor(IAqua aqua) AquaApp(aqua) {}

    function hashOf(Board calldata board) public pure returns (bytes32) {
        return keccak256(abi.encode(board));
    }

    /// @notice What `amountIn` of `buy` is worth, at the price on the board.
    /// @dev No balance appears in this. That is the whole difference from a constant product,
    ///      and it is why a zero balance on the `buy` side is not a special case here.
    function quote(Board calldata board, uint256 amountIn) public pure returns (uint256) {
        return amountIn * board.priceE18 / 1e18;
    }

    /// @notice The taker hands over `amountIn` of `buy` and receives `sell` at the board's price.
    /// @dev The order matches the protocol's: `pull` first, then the taker is called back to pay,
    ///      then `_safeCheckAquaPush` proves they did. The taker is trusted for the length of
    ///      one callback and no longer.
    function fill(Board calldata board, uint256 amountIn, address to)
        external
        nonReentrantStrategy(board.maker, hashOf(board))
        returns (uint256 amountOut)
    {
        require(board.app == address(this), WrongApp(board.app, address(this)));

        bytes32 hash = hashOf(board);
        uint256 taken;
        (amountOut, taken) = _priced(board, hash, amountIn);

        AQUA.pull(board.maker, hash, board.sell, amountOut, to);
        IFixedPriceBoardCallback(msg.sender).fixedPriceBoardCallback(board.buy, amountIn, board.maker, hash);
        _safeCheckAquaPush(board.maker, hash, board.buy, taken + amountIn);

        emit Filled(board.maker, msg.sender, amountIn, amountOut);
    }

    /// @dev Split out of `fill` because holding both balances, the hash and the amounts in one
    ///      frame overflows the stack. `taken` comes back because `_safeCheckAquaPush` needs the
    ///      balance as it was before the pull, and reading it again afterwards would be reading
    ///      a number the callback could have moved.
    function _priced(Board calldata board, bytes32 hash, uint256 amountIn)
        private
        view
        returns (uint256 amountOut, uint256 taken)
    {
        uint256 onOffer;
        (onOffer, taken) = AQUA.safeBalances(board.maker, address(this), hash, board.sell, board.buy);
        require(onOffer > 0, NothingToSell());

        amountOut = quote(board, amountIn);
        require(amountOut <= onOffer, NotEnoughOnTheBoard(amountOut, onOffer));
    }
}
