// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AquaApp} from "@1inch/aqua/AquaApp.sol";
import {IAqua} from "@1inch/aqua/interfaces/IAqua.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IHelicoMandateSwapCallback} from "./IHelicoMandateSwapCallback.sol";
import {ILendingVenue} from "./ILendingVenue.sol";

/// @notice The rules a maker commits to when handing an agent the right to trade their wallet.
///
/// @dev Aqua never reads these bytes. It stores `keccak256(strategy)` of whatever the maker
///      shipped and hands the app a ledger keyed by that hash, so every field below is enforced
///      here or nowhere. A field nobody reads is worse than a missing one: it reads as a promise
///      and behaves as decoration.
///
///      Aqua also makes a shipped strategy immutable for the lifetime of its hash, and docking
///      burns that hash permanently. Changing any rule therefore means docking and shipping new
///      bytes — which is what `salt` exists for.
/// @notice A lending market a mandate permits its capital to sit in, and the receipt tokens
///         that come back from it.
///
/// @dev The maker names these when they ship, so the list is frozen with everything else in the
///      mandate. That is the point: the app can move capital *among* them without anybody
///      holding a privilege, and nobody — including us — can add one afterwards.
///
///      `receipt0`/`receipt1` may be zero, meaning that side is not supplied here.
struct Venue {
    address pool;
    address receipt0;
    address receipt1;
}

struct SwapMandate {
    /// @dev Whose wallet the tokens come from. Aqua keys balances by the shipping address, but
    ///      it never checks that the address inside the bytes agrees, so the app must carry it
    ///      and use it as the maker for every Aqua call.
    address maker;
    /// @dev The two sides of the pair. Order is the maker's choice; `zeroForOne` is read
    ///      against this order, not against numeric address order.
    address token0;
    address token1;
    /// @dev Swap fee in basis points, kept by the maker. Must be below `BPS_BASE`.
    uint256 feeBps;
    /// @dev Per-swap ceiling on how much `token0` may leave the maker's wallet.
    ///
    ///      The ceiling is on the way *out*, per token, and both choices are deliberate.
    ///
    ///      Out, because that is where a maker's loss lives. An input ceiling only bounds the
    ///      output through the curve, and the curve can be made to pay out everything: with a
    ///      zero balance on the input side, constant product returns the whole opposite reserve
    ///      for two wei of input. `DegenerateReserves` closes that hole, but the limit a maker
    ///      actually means is still "never hand over more than this".
    ///
    ///      Per token, because a single scalar cannot mean anything across a pair. `1000e6` is
    ///      1000 USDC in one direction and 10^-12 WETH in the other.
    uint256 maxOut0;
    /// @dev Per-swap ceiling on how much `token1` may leave the maker's wallet.
    uint256 maxOut1;
    /// @dev First timestamp at which the mandate is dead. A swap at exactly `expiry` is refused.
    ///
    ///      Zero means permanently dead, not "no expiry", and Aqua offers no way to repair it:
    ///      the mandate is immutable and its hash cannot be re-shipped after docking. Treated as
    ///      an error at ship time rather than left as a trap.
    uint64 expiry;
    /// @dev The only address allowed to call a swap, or zero to let anyone call it.
    ///
    ///      This is `msg.sender`, so it names a contract — see `IHelicoMandateSwapCallback` for
    ///      why an EOA can never be a taker here. Rotating it costs a dock and a re-ship, which
    ///      is the price of Aqua's immutability, not a limitation of this app.
    address agent;
    /// @dev Distinguishes two mandates that are otherwise identical. Aqua refuses to re-ship a
    ///      hash it has ever seen, so re-issuing the same rules requires a fresh salt.
    bytes32 salt;
    /// @dev Lending markets this capital may sit in while it waits to be traded. **Empty means
    ///      the mandate behaves exactly as it did before this existed** — every path below is a
    ///      no-op, which is what makes the original tests a regression guard rather than a
    ///      rewrite.
    ///
    ///      Because Aqua never lets an app touch a token the maker did not ship to it, the
    ///      receipt tokens are shipped alongside `token0`/`token1` and unwound through
    ///      `AQUA.pull` like anything else. That is deliberate and it is the security of the
    ///      whole feature: the alternative — an ERC-20 approval on the receipt token to this
    ///      contract — would be custody of the maker's entire lending position, outliving the
    ///      mandate, unaffected by `maxOut`, and not revoked by `dock`.
    Venue[] venues;
}

/// @dev The resolved sides of one swap. A struct rather than four return values because four
///      of them plus the swap's own parameters overflow the stack, and a memory pointer costs
///      one slot. Turning on `via_ir` would also fix it, at 4.6x the build time.
struct Sides {
    address tokenIn;
    address tokenOut;
    uint256 balanceIn;
    uint256 balanceOut;
}

/// @title HelicoMandateSwap
/// @notice An Aqua app that lets a maker hand an agent a bounded right to trade their wallet.
///
/// @dev The liquidity never moves into this contract, or into Aqua. `pull` sends the maker's
///      tokens straight to the recipient and `push` sends the taker's straight to the maker;
///      Aqua only keeps the ledger that says how much of the maker's wallet this app may spend.
///      What this app adds is the mandate: an expiry, a named agent, and a per-token ceiling on
///      the way out, checked on every swap.
///
///      Only exact-in is offered. The ceiling belongs on the output, and under exact-in the
///      output is computed from the curve rather than named by the taker, so checking it there
///      constrains something the taker does not control. Exact-out would hand the taker the
///      number the ceiling is meant to bound; it can be added later, deliberately, rather than
///      arriving as a symmetry nobody asked for.
contract HelicoMandateSwap is AquaApp {
    /// @notice Basis-point denominator (100% = 10_000 bps).
    uint256 internal constant BPS_BASE = 10_000;

    /// @notice The output fell below what the caller was willing to accept.
    error InsufficientOutputAmount(uint256 amountOut, uint256 amountOutMin);
    /// @notice The swap would move more of `token` out of the maker's wallet than allowed.
    error MandateCeilingExceeded(address token, uint256 amountOut, uint256 maxOut);
    /// @notice The mandate is dead. `expiry` is the first dead second.
    error MandateExpired(uint256 nowTimestamp, uint256 expiry);
    /// @notice The mandate names an agent and the caller is not it.
    error UnauthorizedAgent(address caller, address agent);
    /// @notice `feeBps` is at or above 100%, which makes the curve meaningless.
    error InvalidFee(uint256 feeBps);
    /// @notice The pair names the same token twice, so there is no swap to make.
    error IdenticalTokens(address token);
    /// @notice A side of the pair holds nothing, so the curve would pay out the other side
    ///         entirely for dust.
    error DegenerateReserves(uint256 balanceIn, uint256 balanceOut);
    /// @notice A named venue is not a contract.
    error VenueHasNoCode(address pool);
    /// @notice A receipt token collides with one of the traded tokens, which would make the
    ///         unwind spend the very reserve it is trying to top up.
    error ReceiptAliasesReserve(address token);
    /// @notice The maker has borrowed against this collateral.
    /// @dev Refused rather than attempted. A lending market blocks a borrower from withdrawing
    ///      collateral, so the withdrawal would fail anyway — but as the market's error, from
    ///      inside our call, after the mandate looked fine. A borrowing maker can also be
    ///      liquidated, which takes the position the mandate depends on.
    error MakerHasDebt(address maker, uint256 debtBase);
    /// @notice No permitted venue can cover the shortfall right now.
    /// @dev Checked before the market is touched. Aave's own limit is an unchecked subtraction
    ///      on its virtual balance, so exceeding it panics from inside Aave rather than
    ///      reverting with anything a caller could read.
    error NoVenueCanCover(address token, uint256 needed);
    /// @notice The unwind returned less than the swap needs. The last line of defence.
    error UnwindFellShort(address token, uint256 held, uint256 needed);

    /// @param aqua_ The Aqua deployment this app keeps its ledger in.
    constructor(IAqua aqua_) AquaApp(aqua_) {}

    /// @notice The identifier Aqua files a mandate under.
    /// @dev Aqua hashes the raw bytes the maker shipped, so this only agrees with Aqua's own
    ///      hash when the maker ships `abi.encode(mandate)`. Ship anything else and the mandate
    ///      is unreachable — `safeBalances` will not find it.
    function mandateHash(SwapMandate calldata mandate) external pure returns (bytes32) {
        return keccak256(abi.encode(mandate));
    }

    /// @notice What a swap would return right now, under the same rules the swap applies.
    /// @dev Every rule the mandate carries is applied here too, deliberately: a quote that
    ///      answers for a mandate the swap would refuse sends an agent to build a transaction
    ///      that cannot land. The one exception is the agent gate, which is about the caller
    ///      rather than the mandate -- see `_checkMandate`.
    /// @param mandate The mandate to quote against.
    /// @param zeroForOne True to sell `token0` for `token1`.
    /// @param amountIn The exact input amount.
    /// @return amountOut What the maker would hand over.
    function quoteExactIn(SwapMandate calldata mandate, bool zeroForOne, uint256 amountIn)
        external
        view
        returns (uint256 amountOut)
    {
        Sides memory s = _sides(mandate, keccak256(abi.encode(mandate)), zeroForOne);
        amountOut = _quote(mandate, s.balanceIn, s.balanceOut, amountIn);
        _checkCeiling(mandate, zeroForOne, s.tokenOut, amountOut);
    }

    /// @notice Swap an exact input amount against a mandate.
    ///
    /// @dev Order of events: the mandate's own rules are checked, the output is computed and
    ///      pulled from the maker's wallet to `to`, the caller is called back to pay, and the
    ///      payment is verified. The output moves before the payment arrives, which is safe for
    ///      the same reason a flash loan is: the verification at the end is unconditional, so a
    ///      taker who does not pay reverts the transfer along with everything else.
    ///
    ///      `nonReentrantStrategy` is what makes that verification sound. The check compares a
    ///      balance snapshot taken before the callback against the balance after it, and two
    ///      overlapping swaps on one mandate would both be satisfied by a single payment —
    ///      two payouts for one push. The lock makes the overlap impossible; it is keyed by
    ///      `(maker, hash)`, so a swap against a different mandate may still nest.
    ///
    /// @param mandate The mandate to trade against.
    /// @param zeroForOne True to sell `token0` for `token1`.
    /// @param amountIn The exact input amount.
    /// @param amountOutMin Revert if the output would be below this.
    /// @param to Who receives the output. Need not be the caller.
    /// @param takerData Forwarded to the callback untouched.
    /// @return amountOut What was pulled from the maker.
    function swapExactIn(
        SwapMandate calldata mandate,
        bool zeroForOne,
        uint256 amountIn,
        uint256 amountOutMin,
        address to,
        bytes calldata takerData
    )
        external
        nonReentrantStrategy(mandate.maker, keccak256(abi.encode(mandate)))
        returns (uint256 amountOut)
    {
        require(
            mandate.agent == address(0) || msg.sender == mandate.agent,
            UnauthorizedAgent(msg.sender, mandate.agent)
        );

        bytes32 hash = keccak256(abi.encode(mandate));

        Sides memory s = _sides(mandate, hash, zeroForOne);

        amountOut = _quote(mandate, s.balanceIn, s.balanceOut, amountIn);
        _checkCeiling(mandate, zeroForOne, s.tokenOut, amountOut);
        require(amountOut >= amountOutMin, InsufficientOutputAmount(amountOut, amountOutMin));

        _cover(mandate, hash, s.tokenOut, amountOut);
        _settle(mandate, hash, s, amountIn, amountOut, to, takerData);
    }

    /// @dev Top the maker's wallet up from a lending market, and only by what is missing.
    ///
    ///      **The wallet is spent first, always.** A maker with enough sitting idle never touches
    ///      a lending market at all, so a market being paused or illiquid cannot break a swap
    ///      that did not need it. That is not a gas optimisation — it is what keeps a dependency
    ///      we added from reaching swaps that do not depend on it.
    ///
    ///      The receipt token is pulled through Aqua rather than through an approval to us, so
    ///      the budget is a number the maker shipped and `dock` destroys. And `to` is fixed to
    ///      this contract: if a single path ever let a caller choose it, everything above stops
    ///      being true.
    function _cover(SwapMandate calldata mandate, bytes32 hash, address tokenOut, uint256 amountOut) private {
        if (mandate.venues.length == 0) return;

        uint256 held = IERC20(tokenOut).balanceOf(mandate.maker);
        if (held >= amountOut) return;
        uint256 deficit = amountOut - held;

        (uint256 index, address receipt) = _venueFor(mandate, tokenOut, deficit);

        AQUA.pull(mandate.maker, hash, receipt, deficit, address(this));
        // Sweep rather than ask for `deficit`: burning an exact amount can require marginally
        // more receipt than we hold, because a market rounds the burn against the withdrawer.
        // Sweeping also guarantees this contract ends the call holding none.
        ILendingVenue(mandate.venues[index].pool).withdraw(tokenOut, type(uint256).max, mandate.maker);

        uint256 nowHeld = IERC20(tokenOut).balanceOf(mandate.maker);
        require(nowHeld >= amountOut, UnwindFellShort(tokenOut, nowHeld, amountOut));
    }

    /// @dev The first permitted venue that can actually pay, and the receipt token for this side.
    ///
    ///      First rather than best, deliberately: the maker chose the order when they shipped,
    ///      and a contract that re-ranks them would be making a decision nobody authorised. An
    ///      off-chain agent that wants a different preference ships a different order.
    function _venueFor(SwapMandate calldata mandate, address tokenOut, uint256 deficit)
        private
        view
        returns (uint256 index, address receipt)
    {
        bool zeroSide = tokenOut == mandate.token0;
        for (uint256 i = 0; i < mandate.venues.length; i++) {
            Venue calldata v = mandate.venues[i];
            address r = zeroSide ? v.receipt0 : v.receipt1;
            if (r == address(0)) continue;
            if (ILendingVenue(v.pool).getVirtualUnderlyingBalance(tokenOut) < deficit) continue;
            return (i, r);
        }
        revert NoVenueCanCover(tokenOut, deficit);
    }

    /// @dev Deliver, call back, verify. Its own frame because the swap's own parameters plus the
    ///      resolved sides do not fit on the stack together.
    function _settle(
        SwapMandate calldata mandate,
        bytes32 hash,
        Sides memory s,
        uint256 amountIn,
        uint256 amountOut,
        address to,
        bytes calldata takerData
    ) private {
        AQUA.pull(mandate.maker, hash, s.tokenOut, amountOut, to);
        IHelicoMandateSwapCallback(msg.sender)
            .helicoMandateSwapCallback(
                s.tokenIn, s.tokenOut, amountIn, amountOut, mandate.maker, address(this), hash, takerData
            );
        _safeCheckAquaPush(mandate.maker, hash, s.tokenIn, s.balanceIn + amountIn);
    }

    /// @dev Everything about the mandate itself that must hold before it may be quoted or
    ///      traded, in one place so the quote and the swap cannot drift apart.
    ///
    ///      The agent gate is deliberately not here. It is a fact about the caller, not about
    ///      the mandate: refusing to quote a price to anyone but the agent protects nothing --
    ///      the numbers are readable from the ledger regardless -- and it would stop a router
    ///      or an indexer from pricing a mandate it is perfectly entitled to see.
    function _checkMandate(SwapMandate calldata mandate) private view {
        require(block.timestamp < mandate.expiry, MandateExpired(block.timestamp, mandate.expiry));
        require(mandate.feeBps < BPS_BASE, InvalidFee(mandate.feeBps));
        require(mandate.token0 != mandate.token1, IdenticalTokens(mandate.token0));
        _checkVenues(mandate);
    }

    /// @dev Everything about the lending side that must hold before a quote or a swap.
    ///
    ///      Runs on the quote path too, deliberately. This contract's own rule is that a quote
    ///      which answers for a mandate the swap would refuse sends an agent to build a
    ///      transaction that cannot land — and every refusal here would otherwise surface as a
    ///      market's own error from inside the swap, long after the quote said yes.
    function _checkVenues(SwapMandate calldata mandate) private view {
        if (mandate.venues.length == 0) return;

        for (uint256 i = 0; i < mandate.venues.length; i++) {
            Venue calldata v = mandate.venues[i];
            require(v.pool.code.length > 0, VenueHasNoCode(v.pool));
            // A receipt token that is also a traded token would make the unwind spend the very
            // reserve it is meant to top up, taking the ledger down twice for one swap.
            require(
                v.receipt0 != mandate.token0 && v.receipt0 != mandate.token1,
                ReceiptAliasesReserve(v.receipt0)
            );
            require(
                v.receipt1 != mandate.token0 && v.receipt1 != mandate.token1,
                ReceiptAliasesReserve(v.receipt1)
            );
        }

        // Debt is checked once, on the first venue, because a lending market reports a user's
        // aggregate position rather than a per-reserve one.
        (, uint256 debt,,,,) = ILendingVenue(mandate.venues[0].pool).getUserAccountData(mandate.maker);
        require(debt == 0, MakerHasDebt(mandate.maker, debt));
    }

    /// @dev The ceiling that applies to whichever token is leaving the maker.
    function _checkCeiling(SwapMandate calldata mandate, bool zeroForOne, address tokenOut, uint256 amountOut)
        private
        pure
    {
        uint256 maxOut = zeroForOne ? mandate.maxOut1 : mandate.maxOut0;
        require(amountOut <= maxOut, MandateCeilingExceeded(tokenOut, amountOut, maxOut));
    }

    /// @dev Resolves direction and reads the ledger.
    ///
    ///      `safeBalances` is the authenticity check: it reverts unless both tokens belong to a
    ///      live mandate under this app and this maker, which is what stops a caller passing a
    ///      mandate struct they invented. Any tampered field changes the hash and lands on a
    ///      mandate Aqua has never seen.
    function _sides(SwapMandate calldata mandate, bytes32 hash, bool zeroForOne)
        private
        view
        returns (Sides memory s)
    {
        _checkMandate(mandate);
        s.tokenIn = zeroForOne ? mandate.token0 : mandate.token1;
        s.tokenOut = zeroForOne ? mandate.token1 : mandate.token0;
        (s.balanceIn, s.balanceOut) =
            AQUA.safeBalances(mandate.maker, address(this), hash, s.tokenIn, s.tokenOut);
        require(s.balanceIn > 0 && s.balanceOut > 0, DegenerateReserves(s.balanceIn, s.balanceOut));
    }

    /// @dev Constant product after the fee: balanceIn * balanceOut is preserved across the swap.
    function _quote(SwapMandate calldata mandate, uint256 balanceIn, uint256 balanceOut, uint256 amountIn)
        private
        pure
        returns (uint256 amountOut)
    {
        uint256 amountInWithFee = amountIn * (BPS_BASE - mandate.feeBps) / BPS_BASE;
        amountOut = (amountInWithFee * balanceOut) / (balanceIn + amountInWithFee);
    }
}
