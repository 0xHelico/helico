// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @notice The digest an owner signs to authorise one call by their account.
///
/// @dev A library rather than a method on the account, for a reason the seamless flow forces: the
///      owner has to be able to sign **before their account exists**. A first-time user signs once
///      and a relayer opens the account and runs the command in the same transaction, so at
///      signing time there is no contract to ask. `HelicoAccountFactory` can answer for an address
///      that holds no code; the account itself cannot.
///
///      Both callers route through here rather than each computing the same hash. Two copies of
///      one derivation is how a frontend ends up signing something the contract will not verify —
///      the drift is silent, and it appears as a signature that is simply "invalid".
library AccountAuth {
    bytes32 internal constant EXECUTE_TYPEHASH =
        keccak256("Execute(address target,uint256 value,bytes data,uint256 nonce,uint256 deadline)");

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    /// @dev `account` is the verifying contract, so a signature is bound to one account and cannot
    ///      be replayed against another the same owner holds. `block.chainid` binds it to a chain.
    function domainSeparator(address account) internal view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("HelicoAccount"), keccak256("1"), block.chainid, account)
        );
    }

    function executeDigest(
        address account,
        address target,
        uint256 value,
        bytes calldata data,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(EXECUTE_TYPEHASH, target, value, keccak256(data), nonce, deadline));
        return MessageHashUtils.toTypedDataHash(domainSeparator(account), structHash);
    }
}
