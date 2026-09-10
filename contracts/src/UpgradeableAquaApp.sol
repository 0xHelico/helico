// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AquaApp} from "@1inch/aqua/AquaApp.sol";
import {IAqua} from "@1inch/aqua/interfaces/IAqua.sol";

/// @title An Aqua app that can gain a feature without gaining a new address.
///
/// @notice **Why this exists, and what it costs.** Between 8 and 9 September both Aqua apps were
///         redeployed because `ReceiptKind` widened `Venue` by a field. Nothing was wrong with the
///         code at the old addresses; they were simply older than the struct, and a mandate written
///         today would have missed the function entirely. The addresses moved, and every document
///         quoting them moved with them.
///
///         That is the ordinary case rather than an unusual one — a feature lands, the tuple
///         changes, and an immutable app is a new address. Behind a proxy it is an upgrade.
///
/// @dev **What a maker is trusting, stated plainly rather than buried.** An Aqua app can `pull`
///      from the maker's own wallet, so making one upgradeable means whoever holds `UPGRADER` can
///      change what an already-shipped mandate does. That is a real transfer of trust and it does
///      not become smaller by going unmentioned. It is a deliberate choice for this deployment, and
///      the mitigation is that `UPGRADER` is a key held apart from the agent and the deployer —
///      the same separation `HelicoAccount` already uses.
///
///      **A zero `UPGRADER` freezes the app**, and that is a legitimate setting rather than a
///      misconfiguration: it makes the proxy behave exactly like the immutable deployments this
///      replaces, while keeping the address stable if the key is ever granted by a redeploy of the
///      implementation. Nobody can upgrade, and `_authorizeUpgrade` says so by refusing everyone.
///
///      **Storage.** `AquaApp` is inherited first so `_reentrancyLocks` keeps slot 0, which is
///      where the non-upgradeable deployments put it — an upgrade from one of those would find its
///      own layout. OpenZeppelin v5's `UUPSUpgradeable` declares no storage of its own; it lives in
///      the ERC-1967 slots, which are hashes and cannot collide with slot 0.
///      `scripts/check-storage-layout.py` holds that line rather than this comment.
abstract contract UpgradeableAquaApp is AquaApp, UUPSUpgradeable {
    /// @notice The only address that may replace this app's implementation. Zero means nobody.
    address public immutable UPGRADER;

    error NotUpgrader(address caller);
    error ImplementationHasNoCode(address implementation);

    /// @dev Not named `Upgraded`: ERC-1967 emits `Upgraded(address)` in the same transaction, and
    ///      two events sharing a name with different shapes is how an indexer keyed on the name
    ///      gets two answers. `HelicoAccount` carries the same note for the same reason.
    event UpgradeAuthorised(address indexed implementation, address indexed by);

    constructor(IAqua aqua, address upgrader) AquaApp(aqua) {
        UPGRADER = upgrader;
    }

    /// @dev The code check is not ceremony. `upgradeToAndCall` to an address with no code leaves a
    ///      proxy that delegatecalls into nothing — every call returns success with empty data,
    ///      which reads as a working contract that answers zero to everything.
    function _authorizeUpgrade(address implementation) internal override {
        require(msg.sender == UPGRADER, NotUpgrader(msg.sender));
        require(implementation.code.length > 0, ImplementationHasNoCode(implementation));
        emit UpgradeAuthorised(implementation, msg.sender);
    }
}
