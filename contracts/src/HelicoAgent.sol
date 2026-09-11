// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {IReceiver} from "./IReceiver.sol";

/// @dev The two calls an account lets its agent make. Declared here rather than imported from
///      `HelicoAccount` so this contract depends on the account's ABI and not on its bytecode: the
///      account is upgradeable and this is not, and the pair has to survive that.
interface IIdleAccount {
    function supplyIdle(address pool, address asset, uint256 amount) external;
    function withdrawIdle(address pool, address asset, uint256 amount) external;
}

/// @notice The agent an account nominates — a contract, and the only thing that can make it act
///         is a report the Chainlink Workflow DON has signed.
///
/// @dev `HelicoAccount.supplyIdle` and `withdrawIdle` authorise by `msg.sender`, so whoever the
///      account names as its agent has to send the transaction itself. Until this contract, that
///      agent was a key: the enclave decided, signed a statement, handed it to the DON — and the
///      statement stopped there, because nothing held the key that could carry it. Every run since
///      the policy allowed a move has decided the same move and moved nothing.
///
///      This closes the gap without a key at all. The account names this contract as its agent,
///      and the only path into `onReport` is the `KeystoneForwarder`, which only routes reports the
///      DON has signed. The DON's report *is* the transaction, and the enclave's decision reaches
///      the chain by the same mechanism that attested to it.
///
///      **What the DON can make this contract do is exactly what the account lets an agent do**,
///      and nothing about that changes here: move the account's own money between the account and
///      a market the owner permitted. Neither call has a recipient; a report cannot name one.
///
///      Two identities are fixed at construction:
///
///        - `FORWARDER`, the production `KeystoneForwarder` on this chain. `route` records every
///          transmission by (receiver, workflow execution, report id) and refuses a repeat, so a
///          report that has been delivered cannot be delivered again through it.
///        - `WORKFLOW_OWNER`, the CRE key that deploys Helico's workflows. The forwarder hands each
///          receiver the workflow's identity, and a report from a workflow somebody else deployed —
///          however well it verifies — is refused. The workflow **id** is deliberately not pinned:
///          it changes with every deploy of the binary or its config, and a receiver that has to be
///          replaced to follow it is a receiver that falls behind.
///
///      No setters, and no storage at all. Both identities are immutables, which live in the code
///      and not in the proxy's storage — so the one way to change either is the one way to change
///      anything here: `UPGRADER` replaces the implementation, the way it can for `HelicoMandateSwap`
///      and the account itself. That is deliberate. A receiver whose forwarder is a plain setter is
///      a receiver whose forwarder can be set to an externally owned account by whoever holds the
///      setter's key; behind UUPS the same power exists, but it is the one key already trusted with
///      more than this, and it is one key for the whole system rather than one more.
///
///      **What an upgrade here cannot do.** The account, not this contract, decides what an agent
///      may call: `supplyIdle` and `withdrawIdle`, both of which move the account's money to a
///      place the account already owns. A replaced implementation can churn that money between the
///      account and its permitted markets, or refuse to move it. It cannot send it anywhere.
///
///      **Stale reports are this contract's to refuse**, per `IReceiver`: a report that reverted here
///      can be retransmitted later with more gas, so the move's own `deadline` — the enclave sets it
///      from DON time — is checked against the block, and a move past it is dropped rather than made
///      at a moment the enclave never looked at.
contract HelicoAgent is IReceiver, UUPSUpgradeable {
    /// @dev The move, field for field with `idleMoveParamsAbi` in `packages/plugins/cre/src/abi.ts`.
    ///      The order is the wire format; the report is `abi.encode(bool act, bytes32 policyHash,
    ///      IdleMove move)` exactly as `encodeReport` in `index.ts` produces it.
    struct IdleMove {
        address account;
        address pool;
        address asset;
        uint256 amount;
        bool supply;
        uint256 deadline;
    }

    /// @dev Where the forwarder puts the workflow owner in `metadata`: `workflowId` (32) then
    ///      `workflowName` (10) then the owner (20). Production delivery appends a two-byte report
    ///      id, so the slice is read at fixed offsets and the length is only required to reach the
    ///      owner — `KeystoneForwarder.sol:305` passes 64 bytes, and a check for exactly 62 would
    ///      refuse every real report.
    uint256 private constant OWNER_OFFSET = 42;
    uint256 private constant METADATA_MIN = OWNER_OFFSET + 20;

    address public immutable FORWARDER;
    address public immutable WORKFLOW_OWNER;
    /// @notice The only address that may replace this contract's implementation. Zero means nobody.
    address public immutable UPGRADER;

    error NotTheForwarder(address caller);
    error NotTheWorkflowOwner(address owner);
    error MetadataTooShort(uint256 length);
    error MoveExpired(uint256 deadline, uint256 blockTime);
    error ZeroAddress();
    error NotUpgrader(address caller);
    error ImplementationHasNoCode(address implementation);

    /// @notice A move the DON decided, made. `policyHash` is the hash of the thresholds the enclave
    ///         applied, so the log says under which policy the money moved.
    event Carried(
        address indexed account,
        address indexed pool,
        address indexed asset,
        uint256 amount,
        bool supplied,
        bytes32 policyHash,
        bytes32 workflowId
    );
    /// @notice A report that said not to act. The workflow does not deliver these today, but the
    ///         wire format has the flag and a receiver that decodes it should say what it saw.
    event Held(bytes32 policyHash, bytes32 workflowId);
    /// @dev Not named `Upgraded`, for the reason `UpgradeableAquaApp` gives: ERC-1967 emits
    ///      `Upgraded(address)` in the same transaction.
    event UpgradeAuthorised(address indexed implementation, address indexed by);

    /// @param upgrader May be zero, which freezes the implementation behind the proxy for good.
    constructor(address forwarder, address workflowOwner, address upgrader) {
        if (forwarder == address(0) || workflowOwner == address(0)) revert ZeroAddress();
        FORWARDER = forwarder;
        WORKFLOW_OWNER = workflowOwner;
        UPGRADER = upgrader;
    }

    /// @inheritdoc IReceiver
    function onReport(bytes calldata metadata, bytes calldata report) external {
        if (msg.sender != FORWARDER) revert NotTheForwarder(msg.sender);
        (bytes32 workflowId, address workflowOwner) = _identity(metadata);
        if (workflowOwner != WORKFLOW_OWNER) revert NotTheWorkflowOwner(workflowOwner);

        (bool act, bytes32 policyHash, IdleMove memory move) = abi.decode(report, (bool, bytes32, IdleMove));
        if (!act) {
            emit Held(policyHash, workflowId);
            return;
        }
        if (move.deadline != 0 && block.timestamp > move.deadline) {
            revert MoveExpired(move.deadline, block.timestamp);
        }

        if (move.supply) {
            IIdleAccount(move.account).supplyIdle(move.pool, move.asset, move.amount);
        } else {
            IIdleAccount(move.account).withdrawIdle(move.pool, move.asset, move.amount);
        }
        emit Carried(move.account, move.pool, move.asset, move.amount, move.supply, policyHash, workflowId);
    }

    /// @inheritdoc IERC165
    /// @dev The forwarder checks this before every call and marks a receiver that answers wrongly as
    ///      invalid for that transmission — permanently, since the record is never cleared. So the
    ///      answer is the interface id and not a hard-coded selector someone might mistype.
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    /// @dev The checks of `UpgradeableAquaApp._authorizeUpgrade`, for the same reasons — the code
    ///      check stops an upgrade to an address with no code, which would leave a proxy answering
    ///      every call with empty success, and the forwarder's ERC165 probe would read that as "not
    ///      a receiver" — plus one: a zero `UPGRADER` is refused by name rather than by the accident
    ///      that nobody can send from the zero address. `msg.sender == UPGRADER` alone is true for a
    ///      call pranked from zero, and a test that proves "frozen" should not need to know that no
    ///      real transaction can do that.
    function _authorizeUpgrade(address implementation) internal override {
        require(UPGRADER != address(0) && msg.sender == UPGRADER, NotUpgrader(msg.sender));
        require(implementation.code.length > 0, ImplementationHasNoCode(implementation));
        emit UpgradeAuthorised(implementation, msg.sender);
    }

    function _identity(bytes calldata metadata)
        private
        pure
        returns (bytes32 workflowId, address workflowOwner)
    {
        if (metadata.length < METADATA_MIN) revert MetadataTooShort(metadata.length);
        workflowId = bytes32(metadata[0:32]);
        workflowOwner = address(bytes20(metadata[OWNER_OFFSET:METADATA_MIN]));
    }
}
