// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Proxy} from "@openzeppelin/contracts/proxy/Proxy.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice One owner's account. The contract the user actually owns.
///
/// @dev Written by hand rather than taken from OpenZeppelin, for one reason that is the whole
///      reason: **the escape hatch has to live somewhere an upgrade cannot reach.**
///
///      A proxy forwards everything to its implementation. Put "send everything back to the
///      owner" in the implementation and the same key that replaces the implementation can
///      delete the way out. An exit that can be revoked is not an exit. So `escape` is a
///      function of this contract, and `OWNER` is `immutable` — it lives in the bytecode, not in
///      storage, so no implementation can write it and no storage layout can shift it.
///
///      **What that costs, written here rather than discovered later.** Two selectors belong to
///      this contract and never reach the implementation: `escape(address[])` and `OWNER()`.
///      Solidity dispatches this contract's own functions before falling through to `_fallback`,
///      so an implementation declaring either of them would find it unreachable. An
///      implementation must not declare them, and a test holds that line.
///
///      The implementation address sits in this proxy's own ERC-1967 slot, not in a shared
///      beacon. A beacon is cheaper — one write changes everyone's code — and that is exactly
///      the shared fate this architecture exists to avoid. Paying for a contract per owner and
///      then wiring them all to one switch buys the cost without the isolation.
contract HelicoAccountProxy is Proxy {
    using SafeERC20 for IERC20;

    /// @notice The one address that can use the escape hatch. Fixed at construction, forever.
    address public immutable OWNER;

    /// @notice Somebody other than the owner tried to use the escape hatch.
    error NotOwner(address caller);
    /// @notice The owner asked for an account with no owner, which has no way out.
    error OwnerIsZero();
    /// @notice The native-currency sweep failed. Reported rather than ignored.
    error EscapeFailed();

    /// @notice Everything the owner asked back has been sent to them.
    event Escaped(address indexed owner, uint256 tokenCount);

    /// @param implementation_ The first implementation. May be replaced later; this cannot.
    /// @param owner_ Who owns this account.
    /// @param initData Forwarded to the implementation, so the account can initialise itself.
    /// @dev Not payable. The factory deploys with zero value, and a direct deployment with value
    ///      and an empty `initData` reverts inside OpenZeppelin's `_checkNonPayable` anyway — so
    ///      `payable` advertised funding-at-deploy that no caller could actually perform.
    constructor(address implementation_, address owner_, bytes memory initData) {
        if (owner_ == address(0)) revert OwnerIsZero();
        OWNER = owner_;
        ERC1967Utils.upgradeToAndCall(implementation_, initData);
    }

    /// @notice Send every named token, and any native currency, back to the owner.
    ///
    /// @dev The only function here that moves value, and it has exactly one destination: `OWNER`,
    ///      read from an immutable. There is no recipient parameter, so there is no version of
    ///      this call that sends somewhere else — not for a caller, and not for an implementation
    ///      that has been replaced by something hostile.
    ///
    ///      Tokens are named by the caller because a contract cannot enumerate what it holds.
    ///      A token that reverts on transfer would strand the whole sweep, so the owner can call
    ///      this again with a shorter list; nothing here depends on a single call succeeding for
    ///      every asset at once.
    ///
    /// @param tokens The ERC-20s to sweep. May be empty to sweep only native currency.
    function escape(address[] calldata tokens) external {
        if (msg.sender != OWNER) revert NotOwner(msg.sender);

        for (uint256 i = 0; i < tokens.length; i++) {
            uint256 balance = IERC20(tokens[i]).balanceOf(address(this));
            if (balance > 0) {
                IERC20(tokens[i]).safeTransfer(OWNER, balance);
            }
        }

        uint256 native = address(this).balance;
        if (native > 0) {
            (bool ok,) = OWNER.call{value: native}("");
            if (!ok) revert EscapeFailed();
        }

        emit Escaped(OWNER, tokens.length);
    }

    /// @notice Accept plain transfers.
    /// @dev Without this, an empty-calldata send falls through to `fallback`, is delegated to an
    ///      implementation that has no fallback of its own, and reverts. An account that cannot be
    ///      paid is not an account — and `escape` sweeps native currency, so it has to be able to
    ///      arrive in the first place.
    receive() external payable {}

    function _implementation() internal view override returns (address) {
        return ERC1967Utils.getImplementation();
    }
}
