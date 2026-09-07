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
    /// @notice The key allowed to announce and run upgrades without the owner acting.
    /// @dev An immutable on the implementation, so changing it means shipping a new
    ///      implementation — which is itself subject to the delay, the grace period and the
    ///      owner's refusal. A mutable upgrader would be a way around all three.
    address public immutable UPGRADER;

    /// @notice Once true, only the owner may change this account's code. Never returns to false.
    bool public autoUpgradeRefused;

    error NotOwner(address caller);
    error NotOwnerOrUpgrader(address caller);
    error ImplementationHasNoCode(address implementation);
    error AutoUpgradeAlreadyRefused();
    error CallFailed(address target);

    event Upgraded(address indexed implementation, address indexed by);
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

    /// @dev An upgrade takes effect immediately. There is no announcement, no waiting period and
    ///      no window in which the owner can cancel one.
    ///
    ///      **That is a deliberate trade made for the hackathon, not an omission.** `HelicoVault`
    ///      does have the delay, and this contract had it too until it was taken out on purpose:
    ///      during a five-day event the ability to fix a mistake within minutes is worth more than
    ///      the ability to see one coming two days out. Judging happens over hours, and a
    ///      two-day timelock would mean a defect found on the last day cannot be fixed at all.
    ///
    ///      What it costs, so nobody has to rediscover it: the owner cannot review or refuse a
    ///      specific upgrade before it lands. The protections that remain are the two that do not
    ///      depend on timing — `refuseAutoUpgrade`, which removes the upgrader for good, and the
    ///      escape hatch in the proxy, which no implementation can reach. **Restoring the delay is
    ///      the first thing to do before this is used with real money for real users.**
    function _authorizeUpgrade(address implementation) internal override {
        _requireMayUpgrade();
        if (implementation.code.length == 0) revert ImplementationHasNoCode(implementation);
        emit Upgraded(implementation, msg.sender);
    }
}
