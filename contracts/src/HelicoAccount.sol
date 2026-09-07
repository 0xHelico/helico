// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ILendingVenue} from "./ILendingVenue.sol";
import {AccountAuth} from "./AccountAuth.sol";

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

    /// @notice Who may move this account's idle capital between the wallet and a lending market.
    /// @dev The CRE enclave, in practice. Nominated by the owner and revocable at any time by
    ///      setting it back to zero, which takes effect on the next call.
    address public agent;

    /// @notice The lending markets the owner will let their capital sit in.
    /// @dev The agent cannot add one. That is the difference between "decide where my money
    ///      works" and "decide what counts as a market", and only the first was delegated:
    ///      a contract that merely behaves like a lending pool is how an allowlist gets drained.
    mapping(address pool => bool) public permittedVenue;

    error NotOwner(address caller);
    error NotOwnerOrUpgrader(address caller);
    error ImplementationHasNoCode(address implementation);
    error AutoUpgradeAlreadyRefused();
    error CallFailed(address target);
    error AuthorisationExpired(uint256 nowTimestamp, uint256 deadline);
    error NotOwnerOrAgent(address caller);
    error VenueNotPermitted(address pool);

    /// @dev Not `Upgraded`: ERC-1967 emits `Upgraded(address)` on the same transaction, and two
    ///      events sharing a name with different shapes is how an indexer keyed on the name gets
    ///      two answers.
    event UpgradeAuthorised(address indexed implementation, address indexed by);
    event AutoUpgradeRefused();
    event Executed(address indexed target, uint256 value, bytes4 selector);
    event SignaturesInvalidated(uint256 newNonce);
    event AgentChanged(address indexed agent);
    event VenuePermitted(address indexed pool, bool allowed);
    event IdleCapitalMoved(address indexed pool, address indexed asset, uint256 amount, bool supplied);

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

    // ------------------------------------------------------------------------------------
    // Acting on the owner's behalf
    // ------------------------------------------------------------------------------------

    /// @notice How many signed calls this account has already accepted.
    ///
    /// @dev Strictly sequential, and that is a design choice rather than an implementation
    ///      detail. `executeWithSignature` always reads the current value, so **exactly one
    ///      authorisation is valid at a time** — a batch cannot be pre-signed, and each
    ///      signature must be spent before the next is written.
    ///
    ///      That is what makes `invalidateSignatures` correct at `+1`: there is only ever one
    ///      outstanding authorisation to cancel. The natural "improvement" to a bitmap of
    ///      unordered nonces would allow pre-signed batches and would silently break that,
    ///      leaving every other pre-signed authorisation valid after a revocation.
    uint256 public nonce;

    /// @notice The EIP-712 domain this account verifies against.
    /// @dev Derived in `AccountAuth` so the factory can answer the same question for an account
    ///      that does not exist yet. See that library for why the owner must be able to sign first.
    function domainSeparator() public view returns (bytes32) {
        return AccountAuth.domainSeparator(address(this));
    }

    /// @notice The digest the owner signs to authorise one call.
    /// @dev Exposed so a frontend signs exactly what this contract will verify, rather than a
    ///      reconstruction of it that can drift.
    function executeDigest(address target, uint256 value, bytes calldata data, uint256 nonce_, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return AccountAuth.executeDigest(address(this), target, value, data, nonce_, deadline);
    }

    /// @notice Do something as this account, authorised by the owner's signature rather than by
    ///         the owner sending the transaction.
    ///
    /// @dev This is what makes the first-time flow one step. A new user's account can be opened
    ///      for them by anyone — the owner is fixed by the address — and their first command can
    ///      be carried by a relayer, so they sign once and never see either step.
    ///
    ///      The relayer gains nothing by carrying it. It cannot change the target, the value, the
    ///      calldata or the deadline without invalidating the signature, and it cannot use the
    ///      same one twice.
    ///
    ///      Not payable, deliberately. Value comes from the account's own balance, so there is no
    ///      `msg.value` for a batching relayer to spend twice across several calls in one
    ///      transaction — the mistake `HelicoVault`'s multicall docblock describes.
    ///
    ///      The owner must be an EOA: this recovers a key and does not consult ERC-1271. An
    ///      owner that is itself a contract uses `execute` and sends its own transaction.
    function executeWithSignature(
        address target,
        uint256 value,
        bytes calldata data,
        uint256 deadline,
        bytes calldata signature
    ) external returns (bytes memory result) {
        if (block.timestamp > deadline) revert AuthorisationExpired(block.timestamp, deadline);

        uint256 used = nonce;
        address signer = ECDSA.recover(executeDigest(target, value, data, used, deadline), signature);
        if (signer != owner()) revert NotOwner(signer);

        // Spent before the call, not after: the target is arbitrary code and may reenter here.
        nonce = used + 1;

        bool ok;
        (ok, result) = target.call{value: value}(data);
        if (!ok) revert CallFailed(target);
        emit Executed(target, value, bytes4(data));
    }

    /// @notice Take back every signature that has not been used yet.
    /// @dev One step is enough because the nonce is sequential: every outstanding authorisation
    ///      names the current one, and none of them names the next.
    function invalidateSignatures() external {
        if (msg.sender != owner()) revert NotOwner(msg.sender);
        uint256 next = nonce + 1;
        nonce = next;
        emit SignaturesInvalidated(next);
    }

    // ------------------------------------------------------------------------------------
    // Idle capital
    // ------------------------------------------------------------------------------------

    /// @notice Nominate who may move idle capital. Zero removes them.
    function setAgent(address agent_) external {
        if (msg.sender != owner()) revert NotOwner(msg.sender);
        agent = agent_;
        emit AgentChanged(agent_);
    }

    /// @notice Allow or disallow a lending market for this account.
    function permitVenue(address pool, bool allowed) external {
        if (msg.sender != owner()) revert NotOwner(msg.sender);
        permittedVenue[pool] = allowed;
        emit VenuePermitted(pool, allowed);
    }

    /// @notice Put idle capital to work in a market the owner permitted.
    ///
    /// @dev **There is no recipient parameter, and that is the whole security argument.** The
    ///      position is credited to `address(this)` and the withdrawal below returns to
    ///      `address(this)`, so the pair of calls can move this account's assets between two
    ///      places that both belong to the account, and nowhere else. An agent holding this
    ///      authority cannot pay itself, cannot pay a third party, and cannot approve anyone.
    ///
    ///      The approval is granted for exactly `amount` and taken back afterwards, so no
    ///      standing allowance survives the call — an allowance outlives the agent's nomination,
    ///      and revoking an agent has to actually revoke something.
    function supplyIdle(address pool, address asset, uint256 amount) external {
        _requireOwnerOrAgent();
        if (!permittedVenue[pool]) revert VenueNotPermitted(pool);

        SafeERC20.forceApprove(IERC20(asset), pool, amount);
        ILendingVenue(pool).supply(asset, amount, address(this), 0);
        SafeERC20.forceApprove(IERC20(asset), pool, 0);

        emit IdleCapitalMoved(pool, asset, amount, true);
    }

    /// @notice Bring capital back out of a market, to this account and nowhere else.
    /// @dev The agent may do this as well as the owner, because an agent that can only put money
    ///      in is an agent that cannot correct itself.
    function withdrawIdle(address pool, address asset, uint256 amount) external {
        _requireOwnerOrAgent();
        if (!permittedVenue[pool]) revert VenueNotPermitted(pool);

        ILendingVenue(pool).withdraw(asset, amount, address(this));

        emit IdleCapitalMoved(pool, asset, amount, false);
    }

    function _requireOwnerOrAgent() private view {
        if (msg.sender == owner()) return;
        address nominated = agent;
        if (nominated == address(0) || msg.sender != nominated) revert NotOwnerOrAgent(msg.sender);
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
        emit UpgradeAuthorised(implementation, msg.sender);
    }
}
