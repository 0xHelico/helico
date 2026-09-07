// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";

import {HelicoAccountProxy} from "./HelicoAccountProxy.sol";

/// @notice Opens one account per owner, at an address known before it exists.
///
/// @dev `CREATE2` with the owner's address as the salt. The useful consequence is that an
///      owner's account address can be shown, and funded, before any transaction creates it —
///      a new user does not spend gas merely to have an address.
///
///      The implementation is fixed at construction. Changing which code new accounts start
///      from means deploying a new factory, which is deliberate: a factory that could be
///      re-pointed would let one key change what every future account is born as, and existing
///      owners would have no way to see it had happened.
contract HelicoAccountFactory {
    /// @notice The implementation every account opened here starts from.
    address public immutable IMPLEMENTATION;

    /// @notice An account was created. Not emitted when `open` finds one already there.
    event AccountOpened(address indexed owner, address account);

    /// @notice An implementation of zero would produce accounts that cannot do anything.
    error ImplementationIsZero();

    constructor(address implementation) {
        if (implementation == address(0)) revert ImplementationIsZero();
        IMPLEMENTATION = implementation;
    }

    /// @notice Where this owner's account is, or will be.
    /// @dev Pure arithmetic on the init code. Answers for owners who have never appeared on
    ///      chain, which is the point.
    function accountFor(address owner) public view returns (address) {
        return Create2.computeAddress(_salt(owner), keccak256(_initCode(owner)));
    }

    /// @notice Whether this owner's account has been created yet.
    function isOpen(address owner) external view returns (bool) {
        return accountFor(owner).code.length > 0;
    }

    /// @notice Create this owner's account if it does not exist, and return it either way.
    ///
    /// @dev Idempotent on purpose. Two callers racing to open the same account must not leave
    ///      one of them with a reverted transaction: the second gets the address the first
    ///      created. Anyone may open an account for anyone, because opening it grants nothing —
    ///      the owner is baked into the address, so an account opened by a stranger is the same
    ///      account the owner would have opened themselves.
    function open(address owner) external returns (address account) {
        account = accountFor(owner);
        if (account.code.length > 0) return account;

        account = Create2.deploy(0, _salt(owner), _initCode(owner));
        emit AccountOpened(owner, account);
    }

    function _salt(address owner) private pure returns (bytes32) {
        return keccak256(abi.encode(owner));
    }

    function _initCode(address owner) private view returns (bytes memory) {
        return abi.encodePacked(
            type(HelicoAccountProxy).creationCode,
            // No init payload. The account reads its owner from this proxy's immutable rather
            // than being told it, so there is nothing to initialise and no second place for the
            // answer to live. A constructor-time call could not read it anyway: the proxy's own
            // code is not deployed until its constructor returns.
            abi.encode(IMPLEMENTATION, owner, bytes(""))
        );
    }
}
