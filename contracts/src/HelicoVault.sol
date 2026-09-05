// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    AccessControlUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
// OpenZeppelin 5.7 dropped ReentrancyGuardUpgradeable: the base guard keeps its flag in an
// ERC-7201 namespaced slot and reads it as `value == ENTERED`, so an uninitialised slot
// already behaves as "not entered" and no initializer is needed behind a proxy. The
// transient variant is avoided on purpose - it requires EIP-1153, and Robinhood Chain's
// support for that could not be verified from here.
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {Mandate, MandateLib, PoolKey} from "./Mandate.sol";
import {IPositionManager} from "./IPositionManager.sol";

/// @title HelicoVault
/// @notice Enforces a user's committed mandate on an agent that re-centres their Uniswap v4
///         liquidity position.
///
/// @dev The vault is non-custodial. The user keeps their position NFT and approves this
///      contract to act on it; the vault never holds it. Revoking that approval, or calling
///      `revoke`, ends the agent's authority immediately and cannot be blocked by anyone —
///      not the agent, not the guardian, not an upgrade.
///
///      The agent chooses *whether* and *where* to re-centre. The contract decides what is
///      allowed. Every rejection path is a test in `HelicoVault.t.sol`.
contract HelicoVault is AccessControlUpgradeable, PausableUpgradeable, ReentrancyGuard, UUPSUpgradeable {
    using MandateLib for Mandate;
    using MandateLib for PoolKey;

    /// @notice May propose actions. Holding it grants no power beyond a committed mandate.
    bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE");
    /// @notice May pause actions. Cannot block a user exit.
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    /// @notice May schedule and execute upgrades, after the timelock.
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    /// @notice How long an upgrade waits before it may be executed, giving users a window to leave.
    uint256 public constant UPGRADE_DELAY = 2 days;

    struct Position {
        Mandate mandate;
        uint64 lastActionAt;
        bool active;
    }

    /// @dev tokenId => the mandate committed for it.
    mapping(uint256 => Position) private _positions;

    IPositionManager public positionManager;

    /// @dev implementation => timestamp it becomes executable. Zero means not scheduled.
    mapping(address => uint256) public upgradeReadyAt;

    /// @dev Reserved so later versions can add state without shifting what is already stored.
    uint256[44] private __gap;

    event MandateSet(uint256 indexed tokenId, address indexed owner, bytes32 mandateHash);
    event Revoked(uint256 indexed tokenId, address indexed owner);
    event Recentred(
        uint256 indexed tokenId, int24 tickLower, int24 tickUpper, uint128 notional, address agent
    );
    event UpgradeScheduled(address indexed implementation, uint256 readyAt);
    event UpgradeCancelled(address indexed implementation);

    error NotPositionOwner();
    error MandateInactive();
    error MandateExpired();
    error PoolNotPermitted();
    error RangeWidthMismatch();
    error TicksNotSpaced();
    error TicksNotOrdered();
    error CooldownNotElapsed();
    error NotionalTooLarge();
    error ZeroAddress();
    error UpgradeNotScheduled();
    error UpgradeNotReady();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin, address positionManager_) external initializer {
        if (admin == address(0) || positionManager_ == address(0)) revert ZeroAddress();

        // UUPSUpgradeable carries no state in OpenZeppelin 5.x, so it has no initializer.
        __AccessControl_init();
        __Pausable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        positionManager = IPositionManager(positionManager_);
    }

    // --- user ---------------------------------------------------------------------------

    /// @notice Commit the rules the agent must stay inside for one position.
    /// @dev Only the position's owner may set it, and setting it again replaces it outright.
    function setMandate(uint256 tokenId, Mandate calldata mandate) external nonReentrant {
        if (positionManager.ownerOf(tokenId) != msg.sender) revert NotPositionOwner();

        Position storage p = _positions[tokenId];
        p.mandate = mandate;
        p.active = true;

        emit MandateSet(tokenId, msg.sender, mandate.hash());
    }

    /// @notice End the agent's authority over a position.
    /// @dev Deliberately not pausable and not role-gated beyond ownership. A user must be able
    ///      to leave while the contract is paused, while the agent is gone, and while an
    ///      upgrade is pending. Revoking the NFT approval achieves the same thing without
    ///      touching this contract at all.
    function revoke(uint256 tokenId) external nonReentrant {
        if (positionManager.ownerOf(tokenId) != msg.sender) revert NotPositionOwner();

        _positions[tokenId].active = false;
        emit Revoked(tokenId, msg.sender);
    }

    function mandateOf(uint256 tokenId) external view returns (Mandate memory) {
        return _positions[tokenId].mandate;
    }

    function isActive(uint256 tokenId) external view returns (bool) {
        return _positions[tokenId].active;
    }

    function lastActionAt(uint256 tokenId) external view returns (uint64) {
        return _positions[tokenId].lastActionAt;
    }

    // --- agent --------------------------------------------------------------------------

    /// @notice Re-centre a position. Every parameter is checked against the committed mandate.
    /// @dev Takes typed parameters rather than router calldata. The vault makes the
    ///      PositionManager call itself, because it cannot validate calldata it would have to
    ///      decode on-chain.
    function recenter(
        uint256 tokenId,
        PoolKey calldata key,
        int24 tickLower,
        int24 tickUpper,
        uint128 notional,
        bytes calldata unlockData,
        uint256 deadline
    ) external onlyRole(AGENT_ROLE) whenNotPaused nonReentrant {
        Position storage p = _positions[tokenId];
        Mandate memory m = p.mandate;

        if (!p.active) revert MandateInactive();
        if (block.timestamp > m.expiry) revert MandateExpired();
        if (key.hashPoolKey() != m.poolId) revert PoolNotPermitted();
        if (notional > m.maxNotional) revert NotionalTooLarge();
        // A fresh mandate has never acted, so there is nothing to cool down from. Without
        // this guard the first action would be blocked until `cooldownSeconds` after the
        // epoch, which is a silent trap on any chain with a low block timestamp.
        if (p.lastActionAt != 0 && block.timestamp < uint256(p.lastActionAt) + m.cooldownSeconds) {
            revert CooldownNotElapsed();
        }

        _checkRange(key.tickSpacing, tickLower, tickUpper, m.rangeWidthBps);

        p.lastActionAt = uint64(block.timestamp);

        positionManager.modifyLiquidities(unlockData, deadline);

        emit Recentred(tokenId, tickLower, tickUpper, notional, msg.sender);
    }

    /// @dev Ticks must be ordered, aligned to the pool's spacing, and span the width the user
    ///      committed to. The agent snapping differently from the contract is the failure this
    ///      prevents.
    function _checkRange(int24 tickSpacing, int24 tickLower, int24 tickUpper, uint16 rangeWidthBps)
        internal
        pure
    {
        if (tickLower >= tickUpper) revert TicksNotOrdered();
        if (tickLower % tickSpacing != 0 || tickUpper % tickSpacing != 0) revert TicksNotSpaced();

        // One tick is a 1.0001x price step, so a width in ticks approximates basis points
        // closely enough at these sizes: 1 bp ≈ 1 tick.
        int24 wanted = int24(uint24(rangeWidthBps));
        int24 spacing = tickSpacing;
        // forge-lint: disable-next-line(divide-before-multiply)
        // Truncating first is the point: this snaps the requested width down to a whole
        // number of tick spacings. Multiplying first would defeat it.
        int24 snapped = (wanted / spacing) * spacing;
        if (snapped == 0) snapped = spacing;

        if (tickUpper - tickLower != snapped) revert RangeWidthMismatch();
    }

    // --- guardian -----------------------------------------------------------------------

    /// @notice Stop the agent acting. Does not affect `revoke`.
    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(GUARDIAN_ROLE) {
        _unpause();
    }

    // --- upgrades -----------------------------------------------------------------------

    /// @notice Announce an upgrade. It becomes executable after `UPGRADE_DELAY`.
    /// @dev The delay is what keeps "you do not have to trust us" honest while the contract is
    ///      upgradeable: users can see a change coming and leave before it takes effect.
    function scheduleUpgrade(address implementation) external onlyRole(UPGRADER_ROLE) {
        if (implementation == address(0)) revert ZeroAddress();
        uint256 readyAt = block.timestamp + UPGRADE_DELAY;
        upgradeReadyAt[implementation] = readyAt;
        emit UpgradeScheduled(implementation, readyAt);
    }

    function cancelUpgrade(address implementation) external onlyRole(UPGRADER_ROLE) {
        delete upgradeReadyAt[implementation];
        emit UpgradeCancelled(implementation);
    }

    function _authorizeUpgrade(address implementation) internal override onlyRole(UPGRADER_ROLE) {
        uint256 readyAt = upgradeReadyAt[implementation];
        if (readyAt == 0) revert UpgradeNotScheduled();
        if (block.timestamp < readyAt) revert UpgradeNotReady();
        delete upgradeReadyAt[implementation];
    }
}
