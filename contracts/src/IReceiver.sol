// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @title IReceiver - receives keystone reports
/// @notice Implementations must support the IReceiver interface through ERC165.
///
/// @dev Copied, not installed: Chainlink does not publish the CRE receiver contracts as a Forge
///      package. Source: `contracts/cre/src/v1/interfaces/IReceiver.sol` in `smartcontractkit/
///      chainlink-evm` at `b6427ea1`, the commit the CRE consumer-contract guide pins. The only
///      edits are the pragma and the OpenZeppelin import path, which here goes through the repo's
///      remapping. `type(IReceiver).interfaceId` is `0x805f2132`, the selector of `onReport` alone —
///      Solidity leaves inherited interfaces out of the id — and `KeystoneForwarder.route` asks for
///      exactly that before it will call a receiver at all.
interface IReceiver is IERC165 {
    /// @notice Handles incoming keystone reports.
    /// @dev If this function call reverts, it can be retried with a higher gas
    /// limit. The receiver is responsible for discarding stale reports.
    /// @param metadata Report's metadata.
    /// @param report Workflow report.
    function onReport(bytes calldata metadata, bytes calldata report) external;
}
