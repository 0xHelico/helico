// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice A Uniswap v4 pool, identified the way the protocol identifies it.
/// @dev `poolId` in a mandate is `keccak256(abi.encode(PoolKey))`, which is also v4's canonical
///      `PoolId`, so the same value indexes `StateView`.
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

/// @notice The rules a user commits to. The agent may choose within these and nothing else.
///
/// @dev Every field is enforced somewhere in `HelicoVault`. A field that is committed, hashed
///      into the user's commitment, and then read by no code path is worse than no field at
///      all: it reads as a promise and behaves as decoration.
struct Mandate {
    /// @dev keccak256(abi.encode(PoolKey)) of the only pool this mandate permits.
    bytes32 poolId;
    /// @dev Exact width of the range to re-centre into, in ticks.
    ///
    ///      Ticks, not basis points. A tick is a 1.0001x price step, so the two only agree for
    ///      narrow bands: a 100 bp band really is ~100 ticks, but a 10,000 bp (2x) band is
    ///      ln(2)/ln(1.0001) = 6,932 ticks, not 10,000. Committing the unit the pool actually
    ///      uses removes the conversion, and with it the drift between what the agent computes
    ///      off-chain and what the contract checks.
    ///
    ///      Must be a whole number of the pool's tick spacings; `setMandate` rejects it
    ///      otherwise rather than snapping, so the range a user gets is the one they signed.
    uint16 rangeWidthTicks;
    /// @dev How much closer to the market price a re-centre must move the range, in basis
    ///      points of the distance it already sits at. Enforced in `recenter` against the
    ///      position's current range and the pool's current tick. Must be below 10,000.
    uint16 minImprovementBps;
    /// @dev Minimum seconds between two actions.
    uint32 cooldownSeconds;
    /// @dev Ceiling on the liquidity `L` a single action may move, measured from
    ///      `getPositionLiquidity` rather than declared by the caller.
    ///
    ///      L, not token value: pricing L needs an oracle the vault does not have, and a cap
    ///      denominated in something the contract cannot measure is not a cap.
    uint128 maxLiquidity;
    /// @dev The agent's authority lapses at this timestamp, with no action required.
    uint64 expiry;
}

library MandateLib {
    /// @dev The layout is (bytes32, uint16, uint16, uint32, uint128, uint64) and the workflow
    ///      that runs inside the enclave recomputes this hash from the same layout. Reordering
    ///      or resizing a field here silently breaks that agreement, so it is checked on both
    ///      sides in `packages/plugins/cre/test/mandate.test.ts`.
    function hash(Mandate memory m) internal pure returns (bytes32) {
        return keccak256(abi.encode(m));
    }

    function hashPoolKey(PoolKey memory key) internal pure returns (bytes32) {
        return keccak256(abi.encode(key));
    }
}
