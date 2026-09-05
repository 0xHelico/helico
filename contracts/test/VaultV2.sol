// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HelicoVault} from "../src/HelicoVault.sol";

/// @notice A trivially different implementation, used only to prove the upgrade path is gated.
contract VaultV2 is HelicoVault {
    function version() external pure returns (uint256) {
        return 2;
    }
}
