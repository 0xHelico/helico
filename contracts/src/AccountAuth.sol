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
/// @notice One call in a batch.
/// @dev Carried in its own struct rather than three parallel arrays, because three arrays can be
///      different lengths and a signature over them would still verify.
struct Call {
    address target;
    uint256 value;
    bytes data;
}

library AccountAuth {
    bytes32 internal constant EXECUTE_TYPEHASH =
        keccak256("Execute(address target,uint256 value,bytes data,uint256 nonce,uint256 deadline)");

    /// @dev EIP-712 requires a referenced struct's definition to follow the primary type's, and
    ///      `Call` sorts after `ExecuteBatch`. Getting that order wrong produces a digest that
    ///      verifies against itself and against nothing a wallet would show the same way.
    bytes32 internal constant CALL_TYPEHASH = keccak256("Call(address target,uint256 value,bytes data)");
    bytes32 internal constant EXECUTE_BATCH_TYPEHASH = keccak256(
        "ExecuteBatch(Call[] calls,uint256 nonce,uint256 deadline)Call(address target,uint256 value,bytes data)"
    );

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    /// @dev `account` is the verifying contract, so a signature is bound to one account and cannot
    ///      be replayed against another the same owner holds. `block.chainid` binds it to a chain.
    function domainSeparator(address account) internal view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("HelicoAccount"), keccak256("1"), block.chainid, account)
        );
    }

    /// @notice The digest the owner signs to authorise a whole batch.
    /// @dev An array of structs hashes as the concatenation of each element's `hashStruct`, then
    ///      that concatenation hashed once. Anything simpler — hashing the encoded array, or the
    ///      fields side by side — is a different digest that no wallet will reproduce.
    function batchDigest(address account, Call[] calldata calls, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes32)
    {
        bytes32[] memory hashes = new bytes32[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            hashes[i] = keccak256(
                abi.encode(CALL_TYPEHASH, calls[i].target, calls[i].value, keccak256(calls[i].data))
            );
        }
        bytes32 structHash = keccak256(
            abi.encode(EXECUTE_BATCH_TYPEHASH, keccak256(abi.encodePacked(hashes)), nonce, deadline)
        );
        return MessageHashUtils.toTypedDataHash(domainSeparator(account), structHash);
    }

    function executeDigest(
        address account,
        address target,
        uint256 value,
        bytes calldata data,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(EXECUTE_TYPEHASH, target, value, keccak256(data), nonce, deadline)
        );
        return MessageHashUtils.toTypedDataHash(domainSeparator(account), structHash);
    }
}
