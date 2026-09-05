// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPositionManager} from "../src/IPositionManager.sol";

/// @notice Stands in for Uniswap v4's PositionManager so the vault's own rules can be tested
///         without a fork. It records the last call so tests can assert the vault forwarded.
contract MockPositionManager is IPositionManager {
    mapping(uint256 => address) public owners;
    mapping(uint256 => uint128) public liquidity;

    bytes public lastUnlockData;
    uint256 public lastDeadline;
    uint256 public callCount;

    function setOwner(uint256 tokenId, address owner) external {
        owners[tokenId] = owner;
    }

    function setLiquidity(uint256 tokenId, uint128 value) external {
        liquidity[tokenId] = value;
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        return owners[tokenId];
    }

    function getPositionLiquidity(uint256 tokenId) external view returns (uint128) {
        return liquidity[tokenId];
    }

    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable {
        lastUnlockData = unlockData;
        lastDeadline = deadline;
        callCount++;
    }
}
