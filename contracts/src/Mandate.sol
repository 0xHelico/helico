// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice A Uniswap v4 pool, identified the way the protocol identifies it.
/// @dev `poolId` in a mandate is `keccak256(abi.encode(PoolKey))`, so the key itself must be
///      supplied with every action and checked against the commitment. The id alone is not
///      enough to act on.
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

/// @notice The rules a user commits to. The agent may choose within these and nothing else.
struct Mandate {
    /// @dev keccak256(abi.encode(PoolKey)) of the only pool this mandate permits.
    bytes32 poolId;
    /// @dev Width of the range to re-centre into, in basis points of price.
    uint16 rangeWidthBps;
    /// @dev Minimum expected improvement, in basis points, before acting is worthwhile.
    uint16 minImprovementBps;
    /// @dev Minimum seconds between two actions.
    uint32 cooldownSeconds;
    /// @dev Ceiling on the value a single action may move.
    uint128 maxNotional;
    /// @dev The agent's authority lapses at this timestamp, with no action required.
    uint64 expiry;
}

library MandateLib {
    function hash(Mandate memory m) internal pure returns (bytes32) {
        return keccak256(abi.encode(m));
    }

    function hashPoolKey(PoolKey memory key) internal pure returns (bytes32) {
        return keccak256(abi.encode(key));
    }
}
