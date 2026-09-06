// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title The door a Chainlink CRE report comes through.
///
/// @dev Read from `smartcontractkit/chainlink-evm`, `contracts/cre/src/v1/interfaces/IReceiver.sol`
///      and the `KeystoneForwarder` that calls it. Two things about that contract shape this
///      one:
///
///      1. `KeystoneForwarder.report(...)` has **no caller restriction at all**. Its security is
///         the DON signatures it checks — exactly `f + 1`, each from a registered signer, no
///         duplicates — not who sent the transaction. So anybody may push a valid report, and
///         the receiver's only job is to insist the call arrived through the forwarder.
///      2. The forwarder refuses to replay a transmission it has already attempted, but a report
///         that is simply *old* still gets through. Its own documentation says so: "the receiver
///         is responsible for discarding stale reports."
///
///      Chainlink declares this interface as `is IERC165`. It is declared standalone here
///      because the vault already answers ERC-165 through `AccessControlUpgradeable`, and
///      `type(IReceiver).interfaceId` counts only the functions declared in the interface
///      itself, so the identifier is the same either way.
interface IReceiver {
    /// @param metadata Written by the forwarder: the workflow execution id, config id and
    ///        report id. Unused here — the vault authorises on the report's contents, not on
    ///        which run produced it.
    /// @param report The bytes the workflow emitted, verbatim.
    function onReport(bytes calldata metadata, bytes calldata report) external;
}
