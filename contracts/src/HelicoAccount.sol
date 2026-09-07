// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {HelicoAccountProxy} from "./HelicoAccountProxy.sol";

/// @notice The replaceable half of an account: who may do what.
///
/// @dev **This contract stores no owner.** It reads `OWNER` from its own proxy, which holds it in
///      an immutable. One source of truth, in the half that cannot be upgraded — so no version of
///      this code, however it is replaced, can disagree with the escape hatch about who the owner
///      is. The read is an ordinary external call to `address(this)`, which lands on the proxy's
///      own function rather than falling through to here.
///
///      That is also why there is no initializer and why the factory passes no init payload.
///      During the proxy's constructor its own code is not yet deployed, so an initializer that
///      called back to read `OWNER` would revert; one that took the owner as an argument would
///      create a second place for the answer to live. Reading it lazily removes both problems.
///
///      **Two selectors are unavailable here** and must never be declared: `escape(address[])`
///      and `OWNER()` belong to the proxy and never reach this contract.
///      `test_TheProxyOwnsTwoSelectorsAndTheAccountMustNotClaimThem` holds that line.
///
///      Upgrades copy `HelicoVault`'s pattern rather than inventing one: announced first,
///      executable only after a delay, expiring after a grace period, and pinned to the exact
///      code that was announced. The owner may cancel during the delay, and may refuse automatic
///      upgrades permanently.
contract HelicoAccount is UUPSUpgradeable {
    /// @notice How long an announced upgrade waits before it may run.
    uint256 public constant UPGRADE_DELAY = 2 days;
    /// @notice How long it stays runnable after that, before it must be announced again.
    uint256 public constant UPGRADE_GRACE = 7 days;

    /// @notice The key allowed to announce and run upgrades without the owner acting.
    /// @dev An immutable on the implementation, so changing it means shipping a new
    ///      implementation — which is itself subject to the delay, the grace period and the
    ///      owner's refusal. A mutable upgrader would be a way around all three.
    address public immutable UPGRADER;

    struct ScheduledUpgrade {
        uint64 readyAt;
        bytes32 codehash;
    }

    /// @notice Announced upgrades, by implementation address.
    mapping(address implementation => ScheduledUpgrade) public scheduledUpgrades;

    /// @notice Once true, only the owner may change this account's code. Never returns to false.
    bool public autoUpgradeRefused;

    error NotOwner(address caller);
    error NotOwnerOrUpgrader(address caller);
    error UpgradeNotScheduled();
    error UpgradeNotReady(uint256 nowTimestamp, uint256 readyAt);
    error UpgradeExpired(uint256 nowTimestamp, uint256 expiredAt);
    error ImplementationChanged(address implementation);
    error ImplementationHasNoCode(address implementation);
    error AutoUpgradeAlreadyRefused();
    error CallFailed(address target);

    event UpgradeScheduled(address indexed implementation, uint64 readyAt, bytes32 codehash);
    event UpgradeCancelled(address indexed implementation);
    event AutoUpgradeRefused();
    event Executed(address indexed target, uint256 value, bytes4 selector);

    /// @param upgrader The enclave key permitted to keep accounts patched. May be zero, which
    ///        means only the owner ever changes this account's code.
    /// @dev No `_disableInitializers()` because there is nothing to disable: this contract has
    ///      no initializer, and OpenZeppelin v5's `UUPSUpgradeable` does not carry `Initializable`.
    ///      The usual reason for that call — somebody initialising the implementation directly and
    ///      taking ownership of it — cannot arise when ownership is an immutable in each proxy.
    constructor(address upgrader) {
        UPGRADER = upgrader;
    }

    /// @notice Who owns this account.
    /// @dev Read from the proxy, never from storage here. See the contract docblock.
    function owner() public view returns (address) {
        return HelicoAccountProxy(payable(address(this))).OWNER();
    }

    /// @notice Do something as this account.
    /// @dev The owner only. CRE's authority over a user's capital runs through Aqua mandates,
    ///      which the owner ships and can revoke by docking; it does not run through here.
    ///      Keeping the two separate is what lets the owner withdraw one without the other.
    function execute(address target, uint256 value, bytes calldata data)
        external
        payable
        returns (bytes memory result)
    {
        if (msg.sender != owner()) revert NotOwner(msg.sender);
        bool ok;
        (ok, result) = target.call{value: value}(data);
        if (!ok) revert CallFailed(target);
        emit Executed(target, value, bytes4(data));
    }

    /// @notice Announce an upgrade. Runnable after `UPGRADE_DELAY`, expiring `UPGRADE_GRACE` later.
    function scheduleUpgrade(address implementation) external {
        _requireMayUpgrade();
        if (implementation.code.length == 0) revert ImplementationHasNoCode(implementation);

        uint64 readyAt = uint64(block.timestamp + UPGRADE_DELAY);
        bytes32 codehash = implementation.codehash;
        scheduledUpgrades[implementation] = ScheduledUpgrade({readyAt: readyAt, codehash: codehash});
        emit UpgradeScheduled(implementation, readyAt, codehash);
    }

    /// @notice Withdraw an announced upgrade. The owner may always do this; it is the point of
    ///         the delay.
    function cancelUpgrade(address implementation) external {
        _requireMayUpgrade();
        delete scheduledUpgrades[implementation];
        emit UpgradeCancelled(implementation);
    }

    /// @notice Give up automatic upgrades for good. Only the owner, and only once.
    /// @dev One-way on purpose. A switch that can be flipped back is a switch whoever holds the
    ///      upgrade key can flip back.
    function refuseAutoUpgrade() external {
        if (msg.sender != owner()) revert NotOwner(msg.sender);
        if (autoUpgradeRefused) revert AutoUpgradeAlreadyRefused();
        autoUpgradeRefused = true;
        emit AutoUpgradeRefused();
    }

    /// @dev Who may schedule, cancel, and run an upgrade. The owner always. The upgrader too,
    ///      until the owner has refused.
    function _requireMayUpgrade() private view {
        if (msg.sender == owner()) return;
        bool upgraderMayAct = !autoUpgradeRefused && UPGRADER != address(0) && msg.sender == UPGRADER;
        if (!upgraderMayAct) revert NotOwnerOrUpgrader(msg.sender);
    }

    function _authorizeUpgrade(address implementation) internal override {
        _requireMayUpgrade();

        ScheduledUpgrade memory s = scheduledUpgrades[implementation];
        if (s.readyAt == 0) revert UpgradeNotScheduled();
        if (block.timestamp < s.readyAt) revert UpgradeNotReady(block.timestamp, s.readyAt);
        uint256 expiredAt = uint256(s.readyAt) + UPGRADE_GRACE;
        if (block.timestamp > expiredAt) revert UpgradeExpired(block.timestamp, expiredAt);
        // The same address may hold different code than when it was announced: a contract can be
        // destroyed and redeployed at one address. Pinning the hash makes the thing that runs the
        // thing that was reviewed.
        if (implementation.codehash != s.codehash) revert ImplementationChanged(implementation);

        delete scheduledUpgrades[implementation];
    }
}
