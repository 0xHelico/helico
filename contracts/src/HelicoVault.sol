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
import {IStateView} from "./IStateView.sol";

/// @title HelicoVault
/// @notice Enforces a user's committed mandate on an agent that re-centres their Uniswap v4
///         liquidity position.
///
/// @dev The vault is non-custodial. The user keeps their position NFT and approves this
///      contract to act on it; the vault never holds it, never holds tokens, and never names
///      itself as a destination.
///
///      **The vault builds the action plan.** It does not accept router calldata. An earlier
///      draft took validated parameters *and* an opaque `unlockData` blob and forwarded the
///      blob — two disjoint sets, where only the unvalidated one reached the pool. Every
///      mandate check was decorative. The lesson is in the shape of `recenter`: the only
///      things a caller supplies are numbers this contract checks, and the payload is
///      assembled here from them.
///
///      **What a rogue agent can do.** Holding `AGENT_ROLE` lets you re-range a position that
///      committed a mandate, into a band of the committed width, containing the current market
///      price, measurably closer to it than the band already is, no more often than the
///      cooldown allows, keeping at least the share of liquidity the mandate demands, before
///      the mandate expires. The new NFT and every token that leaves the old one go to the
///      position's owner, because those two addresses are the only destinations this contract
///      will write into a payload. There is no path that pays an agent, and no path that
///      touches a position whose owner did not commit a mandate.
///
///      **What it cannot promise.** The agent picks the slippage bounds on the withdrawal, so
///      a dishonest one can still choose bad ones and let the re-range be sandwiched. That is
///      bounded by `amount0Min`/`amount1Min` reaching the pool unmodified, and it is the next
///      thing to tighten - see `docs/plans`. It is written down rather than glossed over.
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
    /// @notice How long an upgrade stays executable once ready. A schedule that never expires
    ///         is a permanent standing authorisation, not a notice period.
    uint256 public constant UPGRADE_GRACE = 7 days;

    uint256 private constant BPS = 10_000;

    // v4 action opcodes, verified against v4-periphery `src/libraries/Actions.sol`.
    uint8 private constant DECREASE_LIQUIDITY = 0x01;
    uint8 private constant MINT_POSITION = 0x02;
    uint8 private constant BURN_POSITION = 0x03;
    uint8 private constant TAKE_PAIR = 0x11;

    /// @dev v4 maps recipient `address(1)` to the caller and `address(2)` to the PositionManager
    ///      itself. Both would send a payout somewhere other than the owner, so an owner address
    ///      below this is refused rather than encoded.
    uint160 private constant FIRST_REAL_ADDRESS = 3;

    struct Account {
        Mandate mandate;
        /// @dev The position currently under the mandate. Re-centring in v4 is burn-and-mint,
        ///      so this changes on every action and the mandate follows it.
        uint256 tokenId;
        uint64 lastActionAt;
        bool active;
    }

    struct ScheduledUpgrade {
        uint64 readyAt;
        /// @dev Pins the announcement to the code users were given a window to inspect. Without
        ///      it, an address can hold different code by the time the window closes.
        bytes32 codehash;
    }

    /// @dev Keyed by the address that committed the mandate, not by tokenId. A tokenId is
    ///      destroyed by the very action it authorises, and it changes hands when the NFT is
    ///      sold; neither is true of the person who agreed to the terms.
    mapping(address => Account) private _accounts;

    IPositionManager public positionManager;
    IStateView public stateView;

    mapping(address => ScheduledUpgrade) public scheduledUpgrades;

    /// @dev Reserved so later versions can add state without shifting what is already stored.
    uint256[46] private __gap;

    event MandateSet(address indexed owner, uint256 indexed tokenId, bytes32 mandateHash);
    event Revoked(address indexed owner, uint256 indexed tokenId);
    event Recentred(
        address indexed owner,
        uint256 indexed fromTokenId,
        uint256 indexed toTokenId,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidityMoved,
        address agent
    );
    event UpgradeScheduled(address indexed implementation, uint64 readyAt, bytes32 codehash);
    event UpgradeCancelled(address indexed implementation);

    error NotPositionOwner();
    error MandateInactive();
    error MandateExpired();
    error PoolNotPermitted();
    error RangeWidthZero();
    error RangeWidthNotSpaced();
    error RangeWidthMismatch();
    error TicksNotSpaced();
    error TicksNotOrdered();
    error RangeOffMarket();
    error NotEnoughImprovement();
    error ImprovementOutOfRange();
    error CooldownNotElapsed();
    error MaxLiquidityZero();
    error LiquidityTooLarge();
    error NothingToMove();
    error UnusableOwner();
    error PositionNotDelivered();
    error RangeNotDelivered();
    error LiquidityNotRetained();
    error RetentionOutOfRange();
    error ZeroAddress();
    error NotAContract();
    error UpgradeNotScheduled();
    error UpgradeNotReady();
    error UpgradeExpired();
    error ImplementationChanged();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin, address positionManager_, address stateView_) external initializer {
        if (admin == address(0) || positionManager_ == address(0) || stateView_ == address(0)) {
            revert ZeroAddress();
        }

        // UUPSUpgradeable carries no state in OpenZeppelin 5.x, so it has no initializer.
        __AccessControl_init();
        __Pausable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        positionManager = IPositionManager(positionManager_);
        stateView = IStateView(stateView_);
    }

    // --- user ---------------------------------------------------------------------------

    /// @notice Commit the rules the agent must stay inside, for one position you own.
    /// @dev One mandate per address. Setting it again replaces it outright and re-points it at
    ///      `tokenId`. `lastActionAt` is deliberately left alone, so the cooldown runs
    ///      continuously across a change of terms.
    function setMandate(uint256 tokenId, Mandate calldata m) external nonReentrant {
        if (positionManager.ownerOf(tokenId) != msg.sender) revert NotPositionOwner();
        if (m.expiry <= block.timestamp) revert MandateExpired();
        if (m.rangeWidthTicks == 0) revert RangeWidthZero();
        if (m.maxLiquidity == 0) revert MaxLiquidityZero();
        if (m.minImprovementBps >= BPS) revert ImprovementOutOfRange();
        if (m.minRetainedBps > BPS) revert RetentionOutOfRange();

        // The pool is read from the position rather than taken on trust, so a mandate cannot
        // commit to a pool the position is not in.
        (PoolKey memory key,) = positionManager.getPoolAndPositionInfo(tokenId);
        if (key.hashPoolKey() != m.poolId) revert PoolNotPermitted();
        if (int24(uint24(m.rangeWidthTicks)) % key.tickSpacing != 0) revert RangeWidthNotSpaced();

        Account storage a = _accounts[msg.sender];
        a.mandate = m;
        a.tokenId = tokenId;
        a.active = true;

        emit MandateSet(msg.sender, tokenId, m.hash());
    }

    /// @notice End the agent's authority.
    /// @dev Deliberately not pausable and not role-gated. A user must be able to leave while
    ///      the contract is paused, while the agent is gone, and while an upgrade is pending.
    ///      It reads no external contract, so it still works if the position no longer exists.
    ///
    ///      This is the in-protocol exit. The authority it ends is this contract's alone -
    ///      the approval on the NFT is the user's to revoke directly on the PositionManager,
    ///      and doing that stops the agent whatever this contract says.
    function revoke() external nonReentrant {
        Account storage a = _accounts[msg.sender];
        if (!a.active) revert MandateInactive();
        a.active = false;
        emit Revoked(msg.sender, a.tokenId);
    }

    function mandateOf(address owner) external view returns (Mandate memory) {
        return _accounts[owner].mandate;
    }

    function isActive(address owner) external view returns (bool) {
        return _accounts[owner].active;
    }

    function positionOf(address owner) external view returns (uint256) {
        return _accounts[owner].tokenId;
    }

    function lastActionAt(address owner) external view returns (uint64) {
        return _accounts[owner].lastActionAt;
    }

    // --- agent --------------------------------------------------------------------------

    /// @param owner The address whose mandate authorises this. Not a recipient the caller
    ///        chooses: it is checked against the position's actual owner, and it is the only
    ///        address written into the payload.
    struct RecenterParams {
        address owner;
        int24 tickLower;
        int24 tickUpper;
        uint256 liquidityToMint;
        uint128 amount0Min;
        uint128 amount1Min;
        uint128 amount0Max;
        uint128 amount1Max;
        uint256 deadline;
    }

    /// @notice Move a position into a new range. The agent chooses whether and where; this
    ///         contract decides what is allowed and builds the plan that carries it out.
    ///
    /// @dev v4 has no re-range action, so this is DECREASE_LIQUIDITY, BURN_POSITION,
    ///      MINT_POSITION, TAKE_PAIR - and the mint issues a new tokenId, which the account
    ///      follows. The mint is funded entirely by the burn: if `liquidityToMint` costs more
    ///      than the withdrawal credited, the batch is left owing and reverts. That is why the
    ///      vault never needs to hold or pay tokens, and why this function is not payable.
    ///
    /// @return newTokenId The position the user now owns.
    function recenter(RecenterParams calldata p)
        external
        onlyRole(AGENT_ROLE)
        whenNotPaused
        nonReentrant
        returns (uint256 newTokenId)
    {
        Account storage a = _accounts[p.owner];
        Mandate memory m = a.mandate;
        uint256 tokenId = a.tokenId;

        if (!a.active) revert MandateInactive();
        if (block.timestamp > m.expiry) revert MandateExpired();
        if (uint160(p.owner) < FIRST_REAL_ADDRESS) revert UnusableOwner();
        // A sold position carries no mandate: the buyer never agreed to one.
        if (positionManager.ownerOf(tokenId) != p.owner) revert NotPositionOwner();
        if (a.lastActionAt != 0 && block.timestamp < uint256(a.lastActionAt) + m.cooldownSeconds) {
            revert CooldownNotElapsed();
        }

        // Measured, not declared. The cap is on what actually moves.
        uint128 liquidity = positionManager.getPositionLiquidity(tokenId);
        if (liquidity == 0) revert NothingToMove();
        if (liquidity > m.maxLiquidity) revert LiquidityTooLarge();

        (PoolKey memory key, uint256 info) = positionManager.getPoolAndPositionInfo(tokenId);
        if (key.hashPoolKey() != m.poolId) revert PoolNotPermitted();
        _checkRange(m, key, info, p.tickLower, p.tickUpper);

        // Effects before the interaction: the cooldown starts and the account follows the
        // token v4 is about to mint, so a re-entrant call finds an account already moved on.
        a.lastActionAt = uint64(block.timestamp);
        newTokenId = positionManager.nextTokenId();
        a.tokenId = newTokenId;

        positionManager.modifyLiquidities(_buildPlan(tokenId, liquidity, key, p), p.deadline);

        _assertDelivered(newTokenId, m, liquidity, p);

        emit Recentred(p.owner, tokenId, newTokenId, p.tickLower, p.tickUpper, liquidity, msg.sender);
    }

    /// @dev The whole payload. Both addresses in it are `p.owner`, which was checked against
    ///      `ownerOf` above - there is no parameter through which a caller names a recipient.
    function _buildPlan(uint256 tokenId, uint128 liquidity, PoolKey memory key, RecenterParams calldata p)
        internal
        pure
        returns (bytes memory)
    {
        bytes memory actions = abi.encodePacked(DECREASE_LIQUIDITY, BURN_POSITION, MINT_POSITION, TAKE_PAIR);

        bytes[] memory params = new bytes[](4);
        // Withdraw the whole position, with the agent's slippage floor.
        params[0] = abi.encode(tokenId, uint256(liquidity), p.amount0Min, p.amount1Min, bytes(""));
        // Burn the now-empty NFT and collect fees. The floor is zero because the decrease
        // above already enforced it on the principal; applying it twice would reject a
        // position whose fees are simply small.
        params[1] = abi.encode(tokenId, uint128(0), uint128(0), bytes(""));
        // Mint the new range to the owner.
        params[2] = abi.encode(
            key, p.tickLower, p.tickUpper, p.liquidityToMint, p.amount0Max, p.amount1Max, p.owner, bytes("")
        );
        // Whatever the mint did not consume goes to the owner, not to this contract.
        params[3] = abi.encode(key.currency0, key.currency1, p.owner);

        return abi.encode(actions, params);
    }

    /// @dev Encoding the right plan is not the same as the plan having happened. These read
    ///      the result back out of the PositionManager.
    function _assertDelivered(
        uint256 newTokenId,
        Mandate memory m,
        uint128 liquidityBefore,
        RecenterParams calldata p
    ) internal view {
        if (positionManager.ownerOf(newTokenId) != p.owner) {
            revert PositionNotDelivered();
        }

        (PoolKey memory newKey, uint256 newInfo) = positionManager.getPoolAndPositionInfo(newTokenId);
        if (newKey.hashPoolKey() != m.poolId) revert PoolNotPermitted();
        if (_tickLower(newInfo) != p.tickLower || _tickUpper(newInfo) != p.tickUpper) {
            revert RangeNotDelivered();
        }

        // How much to mint is the agent's number, and every check above is about *where value
        // went* - all of which pass when an agent mints dust and lets the remainder go back to
        // the owner's wallet. No token is lost; the earning position is. Measured from what was
        // delivered, not from what was asked for.
        uint256 retained = positionManager.getPositionLiquidity(newTokenId);
        if (retained * BPS < uint256(liquidityBefore) * uint256(m.minRetainedBps)) {
            revert LiquidityNotRetained();
        }
    }

    /// @dev Three things about the proposed range: it is the committed shape, it contains the
    ///      market, and it is an improvement on where the liquidity already is.
    function _checkRange(Mandate memory m, PoolKey memory key, uint256 info, int24 tickLower, int24 tickUpper)
        internal
        view
    {
        if (tickLower >= tickUpper) revert TicksNotOrdered();
        if (tickLower % key.tickSpacing != 0 || tickUpper % key.tickSpacing != 0) revert TicksNotSpaced();
        // Exactly the committed width. `setMandate` already refused a width that is not a whole
        // number of spacings, so there is nothing left to snap - and snapping here is how a
        // user ends up in a range they did not agree to.
        if (tickUpper - tickLower != int24(uint24(m.rangeWidthTicks))) revert RangeWidthMismatch();

        (, int24 current,,) = stateView.getSlot0(m.poolId);

        // Liquidity outside the range earns nothing. Constraining width without constraining
        // location leaves the whole product open to a band parked where no trade will reach it.
        if (current < tickLower || current >= tickUpper) revert RangeOffMarket();

        // And it has to be worth doing. Without this, an agent can move the range sideways
        // every cooldown for as long as the mandate lasts, paying gas and fees out of the
        // user's position each time.
        uint256 gapNow = _gapToCentre(current, _tickLower(info), _tickUpper(info));
        uint256 gapNext = _gapToCentre(current, tickLower, tickUpper);
        if (gapNext >= gapNow) revert NotEnoughImprovement();
        if (gapNext * BPS > gapNow * (BPS - uint256(m.minImprovementBps))) revert NotEnoughImprovement();
    }

    /// @dev How far the middle of a range sits from the current tick.
    function _gapToCentre(int24 current, int24 tickLower, int24 tickUpper) internal pure returns (uint256) {
        int256 centre = (int256(tickLower) + int256(tickUpper)) / 2;
        int256 distance = int256(current) - centre;
        return uint256(distance < 0 ? -distance : distance);
    }

    /// @dev v4 packs a position's range into one word:
    ///      200 bits poolId | 24 bits tickUpper | 24 bits tickLower | 8 bits hasSubscriber.
    ///      Offsets and the sign extension are taken from v4-periphery `PositionInfoLibrary`.
    function _tickLower(uint256 info) internal pure returns (int24 tick) {
        assembly ("memory-safe") {
            tick := signextend(2, shr(8, info))
        }
    }

    function _tickUpper(uint256 info) internal pure returns (int24 tick) {
        assembly ("memory-safe") {
            tick := signextend(2, shr(32, info))
        }
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

    /// @notice Announce an upgrade. It becomes executable after `UPGRADE_DELAY` and stops being
    ///         executable `UPGRADE_GRACE` later.
    /// @dev The delay is what keeps "you do not have to trust us" honest while the contract is
    ///      upgradeable: users can see a change coming and leave before it takes effect. That
    ///      only holds if the thing announced is the thing deployed, hence the codehash, and if
    ///      the announcement is not open-ended, hence the grace window.
    function scheduleUpgrade(address implementation) external onlyRole(UPGRADER_ROLE) {
        if (implementation == address(0)) revert ZeroAddress();
        if (implementation.code.length == 0) revert NotAContract();

        uint64 readyAt = uint64(block.timestamp + UPGRADE_DELAY);
        bytes32 codehash = implementation.codehash;
        scheduledUpgrades[implementation] = ScheduledUpgrade({readyAt: readyAt, codehash: codehash});

        emit UpgradeScheduled(implementation, readyAt, codehash);
    }

    function cancelUpgrade(address implementation) external onlyRole(UPGRADER_ROLE) {
        delete scheduledUpgrades[implementation];
        emit UpgradeCancelled(implementation);
    }

    function _authorizeUpgrade(address implementation) internal override onlyRole(UPGRADER_ROLE) {
        ScheduledUpgrade memory s = scheduledUpgrades[implementation];
        if (s.readyAt == 0) revert UpgradeNotScheduled();
        if (block.timestamp < s.readyAt) revert UpgradeNotReady();
        if (block.timestamp > uint256(s.readyAt) + UPGRADE_GRACE) revert UpgradeExpired();
        if (implementation.codehash != s.codehash) revert ImplementationChanged();
        delete scheduledUpgrades[implementation];
    }
}
