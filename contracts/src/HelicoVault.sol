// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    AccessControlUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
// OpenZeppelin 5.7 dropped ReentrancyGuardUpgradeable: the base guard keeps its flag in an
// ERC-7201 namespaced slot and reads it as `value == ENTERED`, so an uninitialised slot
// already behaves as "not entered" and no initializer is needed behind a proxy. The
// transient variant is left for a separate change: it would swap a storage slot for a
// transient one, which is cheaper but is a behaviour change to the guard itself, and this
// contract is already deployed behind a proxy in the deploy rehearsal.
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    EIP712Upgradeable
} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {MulticallUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/MulticallUpgradeable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {Mandate, MandateLib, PoolKey} from "./Mandate.sol";
import {IPositionManager} from "./IPositionManager.sol";
import {IPoolManager, IUnlockCallback} from "./IPoolManager.sol";
import {IStateView} from "./IStateView.sol";
import {IReceiver} from "./IReceiver.sol";
import {TickMath} from "./lib/TickMath.sol";
import {LiquidityAmounts} from "./lib/LiquidityAmounts.sol";

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
///      **Batching.** `multicall` is inherited so a relayer holding authorisations for several
///      users can land them in one transaction. The usual hazard — a `payable` function batched
///      with itself, where `msg.value` is visible in full to every `delegatecall` — cannot arise
///      here, but not for the reason first written down: the vault *does* have payable
///      entries — `upgradeToAndCall` from UUPS, and `receive()`, which no batched call can
///      reach because a `delegatecall` always carries calldata. What makes it safe is that
///      **`multicall` itself
///      is not payable**, so `msg.value` is zero for the whole batch and there is nothing to
///      count twice. `scripts/check-no-payable.py` guards that, since a Solidity test can only
///      show that today's `multicall` rejects value.
///
///      **What it cannot promise.** The agent picks the slippage bounds on the withdrawal, so
///      a dishonest one can still choose bad ones and let the re-range be sandwiched. That is
///      bounded by `amount0Min`/`amount1Min` reaching the pool unmodified, and it is the next
///      thing to tighten - see `docs/plans`. It is written down rather than glossed over.
contract HelicoVault is
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuard,
    UUPSUpgradeable,
    EIP712Upgradeable,
    MulticallUpgradeable,
    IUnlockCallback,
    IReceiver
{
    using SafeERC20 for IERC20;
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

    /// @dev The EIP-712 types the enclave signs. Written out rather than assembled, because
    ///      `encodeType` appends referenced structs after the primary one and a single character
    ///      out of place produces a different digest and a silent, permanent rejection. Mirrored
    ///      in `packages/plugins/cre/src/sign.ts`, and a test pins both to one literal.
    string private constant RECENTER_PARAMS_TYPE = "RecenterParams(address owner,int24 tickLower,"
        "int24 tickUpper,uint256 liquidityToMint,uint128 amount0Min,uint128 amount1Min,"
        "uint128 amount0Max,uint128 amount1Max,bool zeroForOne,uint256 amountIn,"
        "uint256 minAmountOut,uint256 deadline)";

    bytes32 private constant RECENTER_PARAMS_TYPEHASH = keccak256(bytes(RECENTER_PARAMS_TYPE));

    bytes32 private constant RECENTER_TYPEHASH = keccak256(
        abi.encodePacked(
            "Recenter(RecenterParams params,bytes32 mandateHash,uint256 nonce)", RECENTER_PARAMS_TYPE
        )
    );

    // v4 action opcodes, verified against v4-periphery `src/libraries/Actions.sol`.
    uint8 private constant DECREASE_LIQUIDITY = 0x01;
    uint8 private constant MINT_POSITION = 0x02;
    uint8 private constant BURN_POSITION = 0x03;
    uint8 private constant TAKE_PAIR = 0x11;
    uint8 private constant SETTLE = 0x0b;
    uint8 private constant SWEEP = 0x14;

    /// @dev `ActionConstants.OPEN_DELTA` — settle whatever is currently owed rather than a
    ///      named amount.
    uint128 private constant OPEN_DELTA = 0;

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

    IPoolManager public poolManager;

    /// @dev `keccak256` of the payload this contract passed to `poolManager.unlock`, held for
    ///      the length of one `recenter`. A boolean would only say that *some* re-centre is in
    ///      flight; this says which, so the callback cannot be driven with data the vault did
    ///      not build. Deliberately not a reentrancy guard: `recenter` already holds
    ///      OpenZeppelin's, and the callback runs inside that window.
    bytes32 private _expectedUnlock;

    /// @notice One-use counter per position owner, so an authorisation cannot be replayed.
    /// @dev Declared last on purpose. Adding it in the middle is what moved `poolManager` from
    ///      slot 4 to slot 5 — harmless only because nothing was deployed yet. New state goes
    ///      here, and the gap shrinks by the same amount.
    mapping(address => uint256) public nonces;

    /// @notice The Chainlink CRE `KeystoneForwarder` whose calls to `onReport` are honoured.
    /// @dev Zero until an admin sets it, which is the safe default: `msg.sender` is never zero,
    ///      so an unset forwarder refuses every report. Settable rather than fixed at
    ///      construction so one deployment can point at the mock the CRE CLI broadcasts through
    ///      and later at the production forwarder, without a new vault.
    address public forwarder;

    /// @dev Reserved so later versions can add state without shifting what is already stored.
    uint256[42] private __gap;

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
    event ForwarderSet(address indexed forwarder);
    event ReportHeld(address indexed owner, bytes32 mandateHash);

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
    error NothingToMint();
    error NotPoolManager();
    error NoRecentreInFlight();
    error SwapExceedsWithdrawn();
    error SwapOutputTooSmall();
    error PriceLeftTheRange();
    error VaultNotEmpty();
    error PayoutFailed();
    error UnusableOwner();
    error PositionNotDelivered();
    error RangeNotDelivered();
    error LiquidityNotRetained();
    error RetentionOutOfRange();
    error CooldownZero();
    error ZeroAddress();
    error NotAContract();
    error UpgradeNotScheduled();
    error UpgradeNotReady();
    error UpgradeExpired();
    error ImplementationChanged();
    error SignerLacksAgentRole(address signer);
    error WrongNonce();
    error MandateChanged();
    error AuthorisationExpired();
    error NotForwarder();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin, address positionManager_, address stateView_, address poolManager_)
        external
        initializer
    {
        if (
            admin == address(0) || positionManager_ == address(0) || stateView_ == address(0)
                || poolManager_ == address(0)
        ) {
            revert ZeroAddress();
        }

        // UUPSUpgradeable carries no state in OpenZeppelin 5.x, so it has no initializer.
        __AccessControl_init();
        __Pausable_init();
        __EIP712_init("HelicoVault", "1");

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        positionManager = IPositionManager(positionManager_);
        stateView = IStateView(stateView_);
        poolManager = IPoolManager(poolManager_);
    }

    /// @notice Accepts native currency, which a v4 pool with `currency0 == address(0)` pays out
    ///         mid-re-centre.
    /// @dev This also accepts native from anyone. A re-centre measures what it produced against
    ///      the balance it started with, so a stray transfer is excluded from every payout and
    ///      is stuck rather than payable to somebody else. Documented in the README rather than
    ///      swept, because a sweep is a privileged path this contract does not otherwise need.
    /// @dev `Currency.transfer` for native is a bare `call`, so without this every re-centre on
    ///      a native pool would revert at the take, before the swap. The vault still ends every
    ///      call holding nothing: `_settleUp` sends the balance this call produced to the owner
    ///      and asserts what remains equals what was there before.
    receive() external payable {}

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
        // A zero cooldown lets an agent re-centre repeatedly in one block, each time paying the
        // pool's fee and the gas out of the position. Every other field was bounded; this was not.
        if (m.cooldownSeconds == 0) revert CooldownZero();

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

        // Cancels every authorisation the agent has signed and not yet relayed. Without this,
        // revoking and later committing the same terms restores the same mandate hash against
        // an unspent nonce, and a signature from before the revoke becomes valid again — which
        // is an ordinary sequence, not a contrived one.
        nonces[msg.sender]++;

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
        /// @dev Swap direction. Ignored when `amountIn` is zero.
        bool zeroForOne;
        /// @dev How much of the withdrawn side to swap. Zero skips the swap entirely.
        uint256 amountIn;
        /// @dev A convenience for the agent, not a guard. The agent sets it, and a cap the
        ///      agent sets is not a cap — what bounds the swap is the price limit below.
        uint256 minAmountOut;
        uint256 deadline;
    }

    /// @dev Everything `unlockCallback` needs, passed through the PoolManager and back.
    struct Unlock {
        uint256 tokenId;
        uint128 liquidity;
        PoolKey key;
        RecenterParams p;
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
        return _recenter(p);
    }

    /// @notice Carry out a re-centre that an agent authorised by signature rather than by
    ///         sending the transaction.
    ///
    /// @dev **Anyone may call this.** The authority is the signature, not the caller, which is
    ///      the whole point: it lets the decision be made somewhere that cannot hold gas or
    ///      send transactions — a Chainlink CRE enclave — and lets any relayer carry it. The
    ///      agent key exists only inside that enclave, so `AGENT_ROLE` stops being a key
    ///      somebody operates and becomes one nobody can read.
    ///
    ///      `mandateHash` binds the authorisation to the mandate the vault holds **now**. An
    ///      authorisation signed against terms the user has since replaced is refused rather
    ///      than executed against the new ones.
    ///
    ///      The nonce makes it single use, and `deadline` is checked in `_recenter` — by this
    ///      contract and nowhere else, so do not remove it believing v4 repeats the check.
    function recenterWithSignature(
        RecenterParams calldata p,
        bytes32 mandateHash,
        uint256 nonce,
        bytes calldata signature
    ) external whenNotPaused nonReentrant returns (uint256 newTokenId) {
        // Checked again in `_recenter`; here only to spare a relayer the gas of recovering a
        // signature for an authorisation that was never going to execute.
        if (block.timestamp > p.deadline) revert AuthorisationExpired();
        if (nonce != nonces[p.owner]) revert WrongNonce();
        if (_accounts[p.owner].mandate.hash() != mandateHash) revert MandateChanged();

        address signer = ECDSA.recover(_authorisationDigest(p, mandateHash, nonce), signature);
        if (!hasRole(AGENT_ROLE, signer)) revert SignerLacksAgentRole(signer);

        // Consumed before the interaction, so a re-entrant relay of the same authorisation
        // finds the counter already moved on.
        nonces[p.owner] = nonce + 1;

        return _recenter(p);
    }

    /// @notice Carry out a re-centre that a Chainlink CRE workflow decided, delivered by the
    ///         `KeystoneForwarder`.
    ///
    /// @dev This is the path that makes the confidential workflow load-bearing rather than
    ///      adjacent: with the forwarder holding `AGENT_ROLE`'s job, nothing can re-centre a
    ///      position that the enclave did not decide to move.
    ///
    ///      **Authority is the caller here, and only here.** The forwarder has already checked
    ///      `f + 1` DON signatures over these exact bytes before it calls; the vault cannot
    ///      re-check them and does not try. Which is why the equality below is the whole
    ///      security boundary, and why `forwarder` is admin-only.
    ///
    ///      `report` is `abi.encode(bool act, bytes32 mandateHash, RecenterParams p)` — what
    ///      `encodeReport` in `packages/plugins/cre` produces. A hold is not written by the
    ///      workflow at all; the `act` flag is honoured anyway, because a report that says hold
    ///      must never move a position if one ever is.
    ///
    ///      **Stale reports.** The forwarder refuses to replay a transmission it has already
    ///      attempted, but an old report pushed late still arrives, and its own documentation
    ///      makes that the receiver's problem. Three things already answer it, and they are the
    ///      reason nothing further is added here: `p.deadline` is checked in `_recenter` and is
    ///      part of the signed bytes, so a late report is refused outright; `_checkRange` reads
    ///      the tick *now* and rejects a range that no longer contains the market; and the
    ///      cooldown, which `setMandate` refuses to leave at zero, blocks a second move.
    ///
    ///      `mandateHash` binds the verdict to the terms the vault holds now, exactly as it
    ///      does on the signature path. An enclave that decided against terms the user has
    ///      since replaced is refused rather than executed against the new ones.
    function onReport(bytes calldata, bytes calldata report) external override whenNotPaused nonReentrant {
        if (msg.sender != forwarder) revert NotForwarder();

        (bool act, bytes32 mandateHash, RecenterParams memory p) =
            abi.decode(report, (bool, bytes32, RecenterParams));

        if (!act) {
            emit ReportHeld(p.owner, mandateHash);
            return;
        }
        if (_accounts[p.owner].mandate.hash() != mandateHash) revert MandateChanged();

        _recenter(p);
    }

    /// @dev `KeystoneForwarder` delivers to an `IReceiver`, and Chainlink's receivers advertise
    ///      that through ERC-165. `AccessControlUpgradeable` already answers the query; this
    ///      adds the one identifier it does not know about.
    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || super.supportsInterface(interfaceId);
    }

    /// @notice The digest an agent has to sign. Public so a relayer can check its authorisation
    ///         before spending gas on it.
    /// @dev `RecenterParams` is nested as its own struct, so this is
    ///      `keccak256(abi.encode(RECENTER_TYPEHASH, hashStruct(params), mandateHash, nonce))`
    ///      wrapped in the domain separator — what `hashTypedData` produces off-chain.
    function authorisationDigest(RecenterParams calldata p, bytes32 mandateHash, uint256 nonce)
        external
        view
        returns (bytes32)
    {
        return _authorisationDigest(p, mandateHash, nonce);
    }

    function _authorisationDigest(RecenterParams calldata p, bytes32 mandateHash, uint256 nonce)
        internal
        view
        returns (bytes32)
    {
        // Split only to stay off the stack limit. Every field here is a static type, so the
        // concatenation is byte-identical to one `abi.encode` of all thirteen.
        bytes32 paramsHash = keccak256(
            bytes.concat(
                abi.encode(RECENTER_PARAMS_TYPEHASH, p.owner, p.tickLower, p.tickUpper, p.liquidityToMint),
                abi.encode(p.amount0Min, p.amount1Min, p.amount0Max, p.amount1Max),
                abi.encode(p.zeroForOne, p.amountIn, p.minAmountOut, p.deadline)
            )
        );
        return _hashTypedDataV4(keccak256(abi.encode(RECENTER_TYPEHASH, paramsHash, mandateHash, nonce)));
    }

    function _recenter(RecenterParams memory p) internal returns (uint256 newTokenId) {
        Account storage a = _accounts[p.owner];
        Mandate memory m = a.mandate;
        uint256 tokenId = a.tokenId;

        if (!a.active) revert MandateInactive();
        // The only enforcement there is. `modifyLiquiditiesWithoutUnlock` — the entry point
        // this contract uses — takes no deadline and carries no `checkDeadline`; only
        // `modifyLiquidities`, which the swap leg stopped using, ever did. An earlier comment
        // claimed otherwise, and the role-gated path enforced nothing at all.
        if (block.timestamp > p.deadline) revert AuthorisationExpired();
        if (block.timestamp > m.expiry) revert MandateExpired();
        if (uint160(p.owner) < FIRST_REAL_ADDRESS) revert UnusableOwner();
        // A sold position carries no mandate: the buyer never agreed to one.
        if (positionManager.ownerOf(tokenId) != p.owner) revert NotPositionOwner();
        if (a.lastActionAt != 0 && block.timestamp < uint256(a.lastActionAt) + m.cooldownSeconds) {
            revert CooldownNotElapsed();
        }

        // Measured, not declared. The cap is on what actually moves.
        // A re-centre that mints nothing is a withdrawal wearing a re-centre's name: the whole
        // position is burned and every token goes to the owner's wallet. `minRetainedBps` is
        // meant to catch that, but a mandate committing zero opts out of the floor, and zero is
        // a legitimate thing for a user to commit. So this is refused unconditionally, above
        // the floor and independent of it.
        if (p.liquidityToMint == 0) revert NothingToMint();

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

        // The vault takes the pool lock itself rather than letting `modifyLiquidities` take it,
        // because that leaves no room between the burn and the mint — and a swap has to sit
        // there. v4 has no re-range action and an out-of-range position holds one token, which
        // cannot fund a range that contains the price.
        bytes memory payload = abi.encode(Unlock({tokenId: tokenId, liquidity: liquidity, key: key, p: p}));
        _expectedUnlock = keccak256(payload);
        poolManager.unlock(payload);
        _expectedUnlock = bytes32(0);

        _assertDelivered(newTokenId, m, liquidity, p);

        emit Recentred(p.owner, tokenId, newTokenId, p.tickLower, p.tickUpper, liquidity, msg.sender);
    }

    /// @notice Called back by the PoolManager while the vault holds the pool lock.
    /// @dev Not `nonReentrant`, and that is deliberate. This runs inside `recenter`, which
    ///      already holds OpenZeppelin's single guard flag, so the modifier would make every
    ///      re-centre revert with `ReentrancyGuardReentrantCall`. The flag below is what
    ///      distinguishes a callback the vault asked for; `msg.sender` is what makes it safe.
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        if (keccak256(data) != _expectedUnlock) revert NoRecentreInFlight();

        Unlock memory u = abi.decode(data, (Unlock));

        // What the vault already held is not this call's to spend or to pay out.
        uint256 held0 = _balanceOf(u.key.currency0);
        uint256 held1 = _balanceOf(u.key.currency1);

        (uint256 got0, uint256 got1) = _withdraw(u, held0, held1);
        (got0, got1) = _swap(u, got0, got1);
        _mint(u, got0, got1);
        _settleUp(u, held0, held1);

        return "";
    }

    /// @dev Burn the whole position into the vault. `TAKE_PAIR` names this contract because the
    ///      swap needs the tokens here; they leave again before the callback returns.
    function _withdraw(Unlock memory u, uint256 held0, uint256 held1)
        internal
        returns (uint256 got0, uint256 got1)
    {
        bytes memory actions = abi.encodePacked(DECREASE_LIQUIDITY, BURN_POSITION, TAKE_PAIR);
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(u.tokenId, uint256(u.liquidity), u.p.amount0Min, u.p.amount1Min, bytes(""));
        // The decrease already enforced the floor on the principal; applying it again to the
        // fees the burn collects would reject a position whose fees are simply small.
        params[1] = abi.encode(u.tokenId, uint128(0), uint128(0), bytes(""));
        params[2] = abi.encode(u.key.currency0, u.key.currency1, address(this));

        positionManager.modifyLiquiditiesWithoutUnlock(actions, params);

        got0 = _balanceOf(u.key.currency0) - held0;
        got1 = _balanceOf(u.key.currency1) - held1;
    }

    /// @dev Trade the side the new range does not want for the side it does.
    function _swap(Unlock memory u, uint256 got0, uint256 got1) internal returns (uint256, uint256) {
        if (u.p.amountIn == 0) return (got0, got1);

        // The agent may only move what the burn produced. Anything beyond it would have to come
        // from another user's balance or from a donation.
        uint256 available = u.p.zeroForOne ? got0 : got1;
        if (u.p.amountIn > available) revert SwapExceedsWithdrawn();

        // The guard that carries the weight. The limit is the price at the edge of the range
        // the user committed to, so the pool itself halts the swap there and the price cannot
        // be pushed out of that range — not by the agent, not by us. Without it, an agent
        // moves the price after `_checkRange` has already approved the range against it, and
        // mints single-sided while every post-condition still passes.
        // One below the upper edge when the price is going up, because `tickUpper` is exclusive:
        // a fill that reached exactly `getSqrtPriceAtTick(tickUpper)` would land the pool on a
        // tick the mint forbids, so the guard would revert the re-centre precisely when it did
        // its job. The lower edge is inclusive and needs no adjustment.
        uint160 limit = u.p.zeroForOne
            ? TickMath.getSqrtPriceAtTick(u.p.tickLower)
            : TickMath.getSqrtPriceAtTick(u.p.tickUpper) - 1;

        int256 delta = poolManager.swap(
            u.key,
            IPoolManager.SwapParams({
                zeroForOne: u.p.zeroForOne, amountSpecified: -int256(u.p.amountIn), sqrtPriceLimitX96: limit
            }),
            ""
        );

        // BalanceDelta packs amount0 in the upper 128 bits and amount1 in the lower. Negative
        // is owed by us, positive is owed to us.
        int128 d0;
        int128 d1;
        assembly ("memory-safe") {
            d0 := sar(128, delta)
            d1 := signextend(15, delta)
        }

        // Named for the currency rather than the direction: `moved0` is however much token0
        // changed hands, whether the vault paid it or received it. Calling them paid/received
        // reads backwards in one of the two directions.
        uint256 moved0 = _resolve(u.key.currency0, d0);
        uint256 moved1 = _resolve(u.key.currency1, d1);
        if (u.p.zeroForOne) {
            if (moved1 < u.p.minAmountOut) revert SwapOutputTooSmall();
            return (got0 - moved0, got1 + moved1);
        }
        if (moved0 < u.p.minAmountOut) revert SwapOutputTooSmall();
        return (got0 + moved0, got1 - moved1);
    }

    /// @dev Settles one side of a swap delta and returns the amount that moved.
    function _resolve(address currency, int128 amount) internal returns (uint256) {
        if (amount == 0) return 0;
        if (amount < 0) {
            uint256 owed = uint256(uint128(-amount));
            if (currency == address(0)) {
                // v4-core: "if settling native, integrators should still call sync first to
                // avoid DoS attack vectors". `sync` is permissionless and its slot transient,
                // so a hook that dirties it would otherwise make every re-centre on a native
                // pool revert `NonzeroNativeValue`.
                poolManager.sync(address(0));
                poolManager.settle{value: owed}();
            } else {
                poolManager.sync(currency);
                IERC20(currency).safeTransfer(address(poolManager), owed);
                poolManager.settle();
            }
            return owed;
        }
        uint256 due = uint256(uint128(amount));
        poolManager.take(currency, address(this), due);
        return due;
    }

    /// @dev Mint the new range to the owner, funded by what the burn and the swap produced.
    function _mint(Unlock memory u, uint256 got0, uint256 got1) internal {
        // Belt to the price limit's braces: the swap may have moved the tick, and every check
        // in `_assertDelivered` is about where the range is rather than where the price is.
        (uint160 sqrtPriceX96, int24 tick,,) = stateView.getSlot0(u.key.hashPoolKey());
        if (tick < u.p.tickLower || tick >= u.p.tickUpper) revert PriceLeftTheRange();

        // Mint what this call can actually pay for, at the price the swap actually reached,
        // and never more than was authorised.
        //
        // The agent sizes `liquidityToMint` off-chain from a model of the swap. A model is a
        // guess about a curve that moves between the read and the transaction, and the enclave
        // that makes it cannot see the initialised ticks the swap will cross. When the guess
        // is high the whole re-centre used to revert on `MaximumAmountExceeded` — the position
        // burned, the swap done, and nothing minted, for arithmetic rather than for anything
        // the user agreed to.
        //
        // The vault does not have to guess. Here it holds the tokens and can read the price.
        // The cap is what keeps the agent's authority intact: this can only ever mint *less*
        // than was asked for, never more, and `_assertDelivered` still measures the result
        // against `minRetainedBps` — so a swap that went badly still reverts everything.
        uint128 affordable = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(u.p.tickLower),
            TickMath.getSqrtPriceAtTick(u.p.tickUpper),
            got0,
            got1
        );
        uint256 toMint = affordable < u.p.liquidityToMint ? uint256(affordable) : u.p.liquidityToMint;
        if (toMint == 0) revert NothingToMint();

        // The PositionManager pays a settle mapped `payerIsUser = false` out of its own
        // balance, so funding the mint is a transfer to it rather than a Permit2 allowance
        // from the vault to anyone. Whatever it does not spend comes back on the sweep.
        uint256 value;
        if (u.key.currency0 == address(0)) value = got0;
        else if (got0 > 0) IERC20(u.key.currency0).safeTransfer(address(positionManager), got0);
        if (got1 > 0) IERC20(u.key.currency1).safeTransfer(address(positionManager), got1);

        bytes memory actions = abi.encodePacked(MINT_POSITION, SETTLE, SETTLE, SWEEP, SWEEP);
        bytes[] memory params = new bytes[](5);
        // The maxima are what this call is holding, not what the agent predicted it would hold.
        //
        // They used to be `u.p.amount0Max` / `u.p.amount1Max`, sized off-chain from a model of a
        // swap that had not happened. That is the same mistake `toMint` above stopped making,
        // one line later: a swap returning *more* of the binding token than the model expected
        // still reverted on `MaximumAmountExceeded`, with the vault holding plenty.
        //
        // Nothing is given up by dropping them. The vault transferred exactly `got0`/`got1` to
        // the PositionManager and sweeps back what the mint does not spend, so it cannot spend
        // more than this whatever the numbers say, and `_settleUp` asserts the remainder reaches
        // the owner. The agent's maxima bounded the agent's own transaction and protected
        // nobody; `minRetainedBps` is the user's protection and it lives in the mandate.
        //
        // `amount0Min` / `amount1Min` are untouched. They bound the burn, which is a different
        // thing and genuinely protective.
        params[0] = abi.encode(
            u.key, u.p.tickLower, u.p.tickUpper, toMint, _cap(got0), _cap(got1), u.p.owner, bytes("")
        );
        params[1] = abi.encode(u.key.currency0, uint256(OPEN_DELTA), false);
        params[2] = abi.encode(u.key.currency1, uint256(OPEN_DELTA), false);
        // Back to the vault rather than straight to the owner, so what reaches them is an
        // amount this call computed instead of whatever balance happened to be sitting there.
        params[3] = abi.encode(u.key.currency0, address(this));
        params[4] = abi.encode(u.key.currency1, address(this));

        positionManager.modifyLiquiditiesWithoutUnlock{value: value}(actions, params);
    }

    /// @dev Pay the owner exactly what this call produced, and prove the vault kept none of it.
    /// @dev A balance as a `uint128` bound. Saturating rather than reverting: these are upper
    ///      bounds on what the mint may spend, and a balance above `uint128.max` is not a
    ///      reason to refuse a re-centre. No ERC-20 the vault can hold reaches it.
    function _cap(uint256 amount) internal pure returns (uint128) {
        return amount > type(uint128).max ? type(uint128).max : uint128(amount);
    }

    function _settleUp(Unlock memory u, uint256 held0, uint256 held1) internal {
        _payOut(u.key.currency0, u.p.owner, _balanceOf(u.key.currency0) - held0);
        _payOut(u.key.currency1, u.p.owner, _balanceOf(u.key.currency1) - held1);

        // Asserted on chain, not only in a test. The vault is not a custodian, and the only
        // moment it holds anything is between the burn and the mint of this one call.
        if (_balanceOf(u.key.currency0) != held0 || _balanceOf(u.key.currency1) != held1) {
            revert VaultNotEmpty();
        }
    }

    function _payOut(address currency, address to, uint256 amount) internal {
        if (amount == 0) return;
        if (currency == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert PayoutFailed();
        } else {
            IERC20(currency).safeTransfer(to, amount);
        }
    }

    function _balanceOf(address currency) internal view returns (uint256) {
        return currency == address(0) ? address(this).balance : IERC20(currency).balanceOf(address(this));
    }

    /// @dev Encoding the right plan is not the same as the plan having happened. These read
    ///      the result back out of the PositionManager.
    function _assertDelivered(
        uint256 newTokenId,
        Mandate memory m,
        uint128 liquidityBefore,
        RecenterParams memory p
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

    // --- admin --------------------------------------------------------------------------

    /// @notice Point the vault at the `KeystoneForwarder` whose reports it will honour.
    /// @dev A setter rather than a constructor argument because the demo and a deployment need
    ///      different forwarders — the CRE CLI broadcasts through a mock that verifies nothing,
    ///      a deployed workflow goes through the production one — and swapping them should not
    ///      need a new vault. Setting it to zero turns the report path off, since `msg.sender`
    ///      is never zero.
    function setForwarder(address forwarder_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        forwarder = forwarder_;
        emit ForwarderSet(forwarder_);
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
