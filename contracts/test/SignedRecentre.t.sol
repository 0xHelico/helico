// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {HelicoVault} from "../src/HelicoVault.sol";
import {Mandate, MandateLib, PoolKey} from "../src/Mandate.sol";
import {
    MockERC20,
    MockPoolManager,
    MockStateView,
    RealisticPositionManager
} from "./RealisticPositionManager.sol";

/// @notice The authorisation path: the enclave signs, anybody relays, the vault decides.
///
/// @dev The agent key lives in the Chainlink Vault DON and is released only into the enclave,
///      so `AGENT_ROLE` stops being a key somebody operates. Which means the signature is the
///      authority and the caller is irrelevant — and every test here is about that boundary.
contract SignedRecentreTest is Test {
    using MandateLib for PoolKey;

    HelicoVault vault;
    RealisticPositionManager pm;
    MockStateView stateView;
    MockPoolManager poolManager;
    MockERC20 t0;
    MockERC20 t1;

    address admin = makeAddr("admin");
    address user = makeAddr("user");
    address relayer = makeAddr("relayer");
    address stranger = makeAddr("stranger");

    uint256 agentKey = 0xA9E17;
    address agent;

    PoolKey poolKey;
    Mandate mandate;
    uint256 tokenId;

    uint128 constant LIQUIDITY = 1_000_000;

    /// @dev From `cast keccak` over the EIP-712 type strings and the encoded struct, so neither
    ///      side is checking its own arithmetic. `packages/plugins/cre/src/sign.ts` builds the
    ///      same types; if these two literals disagree with it, every signature the enclave
    ///      produces is refused on chain for no visible reason.
    ///
    ///        cast keccak "Recenter(RecenterParams params,bytes32 mandateHash,uint256 nonce)\
    ///          RecenterParams(address owner,int24 tickLower,...)"
    bytes32 constant RECENTER_TYPEHASH = 0xe2076f399e37a41487f04cb9d92f12edf3d9c5d0fa4e9c0c7d492f7640ec7287;
    /// @dev `hashStruct` of the parameters used in the vector below.
    bytes32 constant PARAMS_HASH = 0xee723c64e817eff7bce2860fdbe76eb7b68bdb66aa33c8dfcd9c97caa9d44a7f;

    function setUp() public {
        agent = vm.addr(agentKey);

        t0 = new MockERC20();
        t1 = new MockERC20();
        pm = new RealisticPositionManager(t0, t1);
        stateView = new MockStateView();
        poolManager = new MockPoolManager();

        HelicoVault impl = new HelicoVault();
        bytes memory init = abi.encodeCall(
            HelicoVault.initialize, (admin, address(pm), address(stateView), address(poolManager))
        );
        vault = HelicoVault(payable(address(new ERC1967Proxy(address(impl), init))));

        bytes32 role = vault.AGENT_ROLE();
        vm.prank(admin);
        vault.grantRole(role, agent);

        poolKey = PoolKey({
            currency0: address(t0), currency1: address(t1), fee: 3000, tickSpacing: 10, hooks: address(0)
        });
        stateView.setTick(poolKey.hashPoolKey(), 0);

        tokenId = pm.mintTo(user, poolKey, -300, -200, LIQUIDITY);
        vm.startPrank(user);
        pm.setApprovalForAll(address(vault), true);
        mandate = Mandate({
            poolId: poolKey.hashPoolKey(),
            rangeWidthTicks: 100,
            minImprovementBps: 500,
            cooldownSeconds: 1 hours,
            maxLiquidity: LIQUIDITY,
            expiry: uint64(block.timestamp + 30 days),
            minRetainedBps: 9_000
        });
        vault.setMandate(tokenId, mandate);
        vm.stopPrank();
    }

    function _params() internal view returns (HelicoVault.RecenterParams memory) {
        return HelicoVault.RecenterParams({
            owner: user,
            tickLower: -50,
            tickUpper: 50,
            liquidityToMint: LIQUIDITY,
            amount0Min: 0,
            amount1Min: 0,
            amount0Max: type(uint128).max,
            amount1Max: type(uint128).max,
            zeroForOne: false,
            amountIn: 0,
            minAmountOut: 0,
            deadline: block.timestamp + 60
        });
    }

    function _sign(uint256 key, HelicoVault.RecenterParams memory p, uint256 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = vault.authorisationDigest(p, MandateLib.hash(mandate), nonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    // --- the agreement with the enclave --------------------------------------------------

    /// @notice The digest, pinned to a literal computed with `cast` rather than by this
    ///         contract, over a fixed domain and a fixed set of parameters.
    ///
    /// @dev EIP-712 appends referenced structs to the primary type string, so
    ///      `Recenter(...)RecenterParams(...)` is one string and a single character out of
    ///      place gives a different digest — and a signature the vault silently refuses, for
    ///      no visible reason. `packages/plugins/cre/src/sign.ts` builds the same types; this
    ///      literal is what both sides have to reproduce.
    ///
    ///      Produced by:
    ///        cast keccak "$RECENTER_TYPES" etc., then
    ///        keccak(0x1901 ‖ domainSeparator ‖ hashStruct(Recenter))
    function test_DigestMatchesTheVectorTheEnclaveSigns() public view {
        HelicoVault.RecenterParams memory p = HelicoVault.RecenterParams({
            owner: address(0x00000000000000000000000000000000000000A1),
            tickLower: -600,
            tickUpper: 600,
            liquidityToMint: 123_456_789,
            amount0Min: 1,
            amount1Min: 2,
            amount0Max: 3,
            amount1Max: 4,
            zeroForOne: false,
            amountIn: 555,
            minAmountOut: 666,
            deadline: 1_800_000_000
        });
        bytes32 mandateHash = 0x134be6bb4e1c442551c22dfe96cb5b7c3c31babb386e2e9a051e57ee329a6225;
        uint256 nonce = 7;

        // Everything the two implementations could disagree about, pinned to literals produced
        // by `cast`. The domain is not among them: its chain id and address come from where the
        // vault is deployed, so it is rebuilt here from what the contract reports.
        bytes32 structHash = keccak256(abi.encode(RECENTER_TYPEHASH, PARAMS_HASH, mandateHash, nonce));

        (, string memory name, string memory version, uint256 chainId, address verifying,,) =
            vault.eip712Domain();
        assertEq(name, "HelicoVault", "domain name");
        assertEq(version, "1", "domain version");

        bytes32 separator = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                verifying
            )
        );

        assertEq(
            vault.authorisationDigest(p, mandateHash, nonce),
            keccak256(abi.encodePacked(hex"1901", separator, structHash)),
            "the enclave and the vault must sign and verify the same bytes"
        );
    }

    // --- the authority is the signature, not the caller ----------------------------------

    function test_AnyoneMayRelayAnAgentsAuthorisation() public {
        HelicoVault.RecenterParams memory p = _params();
        bytes memory sig = _sign(agentKey, p, 0);

        vm.prank(relayer);
        uint256 newTokenId = vault.recenterWithSignature(p, MandateLib.hash(mandate), 0, sig);

        assertEq(pm.ownerOf(newTokenId), user, "the position went to its owner");
        assertEq(vault.nonces(user), 1, "and the authorisation was spent");
    }

    function test_RejectsASignatureFromSomebodyWithoutTheRole() public {
        uint256 impostor = 0xBAD;
        HelicoVault.RecenterParams memory p = _params();
        bytes memory sig = _sign(impostor, p, 0);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(HelicoVault.SignerLacksAgentRole.selector, vm.addr(impostor)));
        vault.recenterWithSignature(p, MandateLib.hash(mandate), 0, sig);
    }

    /// @notice An authorisation is single use, so a relayer cannot replay a profitable one.
    function test_AnAuthorisationCannotBeUsedTwice() public {
        HelicoVault.RecenterParams memory p = _params();
        bytes memory sig = _sign(agentKey, p, 0);

        vm.prank(relayer);
        vault.recenterWithSignature(p, MandateLib.hash(mandate), 0, sig);

        vm.prank(relayer);
        vm.expectRevert(HelicoVault.WrongNonce.selector);
        vault.recenterWithSignature(p, MandateLib.hash(mandate), 0, sig);
    }

    /// @notice Changing the terms invalidates every authorisation signed against the old ones.
    ///         Otherwise a user who tightened their mandate would still be exposed to a
    ///         verdict computed under the looser one.
    function test_ReplacingTheMandateInvalidatesAnUnusedAuthorisation() public {
        HelicoVault.RecenterParams memory p = _params();
        bytes32 oldHash = MandateLib.hash(mandate);
        bytes memory sig = _sign(agentKey, p, 0);

        Mandate memory tighter = mandate;
        tighter.maxLiquidity = LIQUIDITY;
        tighter.cooldownSeconds = 2 hours;
        vm.prank(user);
        vault.setMandate(tokenId, tighter);

        vm.prank(relayer);
        vm.expectRevert(HelicoVault.MandateChanged.selector);
        vault.recenterWithSignature(p, oldHash, 0, sig);
    }

    /// @notice Every mandate rule still applies. The signature says who authorised it, never
    ///         what they are allowed to authorise.
    function test_ASignedActionIsStillBoundByTheMandate() public {
        HelicoVault.RecenterParams memory p = _params();
        p.tickLower = -100; // 200 ticks wide against a mandate that committed 100
        bytes memory sig = _sign(agentKey, p, 0);

        vm.prank(relayer);
        vm.expectRevert(HelicoVault.RangeWidthMismatch.selector);
        vault.recenterWithSignature(p, MandateLib.hash(mandate), 0, sig);
    }

    /// @notice A stale authorisation is refused at the door, not deep inside the v4 batch.
    /// @dev The PositionManager would reject it anyway; this only spares a relayer the gas of
    ///      finding out the expensive way, which is the common case for one that has been sat
    ///      on. Asked for on review, and right: it is nearly free.
    function test_RejectsAnExpiredAuthorisationBeforeSpendingGasOnIt() public {
        HelicoVault.RecenterParams memory p = _params();
        bytes memory sig = _sign(agentKey, p, 0);

        skip(61);

        vm.prank(relayer);
        vm.expectRevert(HelicoVault.AuthorisationExpired.selector);
        vault.recenterWithSignature(p, MandateLib.hash(mandate), 0, sig);
    }

    function test_RejectsWhenPaused() public {
        bytes32 guardian = vault.GUARDIAN_ROLE();
        vm.startPrank(admin);
        vault.grantRole(guardian, admin);
        vault.pause();
        vm.stopPrank();

        HelicoVault.RecenterParams memory p = _params();
        bytes memory sig = _sign(agentKey, p, 0);

        vm.prank(relayer);
        vm.expectRevert();
        vault.recenterWithSignature(p, MandateLib.hash(mandate), 0, sig);
    }

    /// @notice Revoking refuses an outstanding authorisation, and keeps refusing it.
    /// @dev The nonce is bumped by `revoke`, so the refusal survives the user later committing
    ///      the *same terms* again — which restores the same mandate hash and, without the
    ///      bump, would restore a valid signature with it. That sequence is ordinary ("pause
    ///      the agent while I travel, turn it back on after"), not contrived.
    function test_RevokeCancelsAnOutstandingAuthorisationForGood() public {
        HelicoVault.RecenterParams memory p = _params();
        bytes32 hash = MandateLib.hash(mandate);
        bytes memory sig = _sign(agentKey, p, 0);

        vm.prank(user);
        vault.revoke();

        vm.prank(relayer);
        vm.expectRevert(HelicoVault.WrongNonce.selector);
        vault.recenterWithSignature(p, hash, 0, sig);

        // Same terms again: same hash, active once more, and the old signature is still refused.
        vm.prank(user);
        vault.setMandate(tokenId, mandate);
        assertEq(vault.nonces(user), 1, "the counter moved and stays moved");

        vm.prank(relayer);
        vm.expectRevert(HelicoVault.WrongNonce.selector);
        vault.recenterWithSignature(p, hash, 0, sig);
    }

    /// @notice And the role-gated path still refuses outright, since the account is inactive.
    function test_RejectsAfterRevoke() public {
        vm.prank(user);
        vault.revoke();

        vm.prank(agent);
        vm.expectRevert(HelicoVault.MandateInactive.selector);
        vault.recenter(_params());
    }

    // --- batching -------------------------------------------------------------------------

    /// @notice The case `multicall` exists for: one relayer, several users, one transaction.
    /// @dev `recenterWithSignature` takes no privileges, so a relayer can hold authorisations
    ///      for many owners at once. Without this they are several transactions; with it they
    ///      are one, and no separate batcher contract has to be deployed and explained.
    function test_ARelayerLandsTwoUsersInOneTransaction() public {
        address second = makeAddr("second user");
        uint256 secondToken = pm.mintTo(second, poolKey, -300, -200, LIQUIDITY);
        vm.startPrank(second);
        pm.setApprovalForAll(address(vault), true);
        vault.setMandate(secondToken, mandate);
        vm.stopPrank();

        HelicoVault.RecenterParams memory a = _params();
        HelicoVault.RecenterParams memory b = _params();
        b.owner = second;

        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(
            HelicoVault.recenterWithSignature, (a, MandateLib.hash(mandate), 0, _sign(agentKey, a, 0))
        );
        calls[1] = abi.encodeCall(
            HelicoVault.recenterWithSignature, (b, MandateLib.hash(mandate), 0, _sign(agentKey, b, 0))
        );

        vm.prank(relayer);
        vault.multicall(calls);

        assertEq(vault.nonces(user), 1, "the first authorisation was spent");
        assertEq(vault.nonces(second), 1, "and so was the second");
        assertEq(pm.ownerOf(vault.positionOf(user)), user, "each position went to its own owner");
        assertEq(pm.ownerOf(vault.positionOf(second)), second, "each position went to its own owner");
    }

    /// @notice A batch is all or nothing, so a relayer cannot land the profitable half of one.
    /// @dev Two different owners, so the failure is unambiguously the second one's range and
    ///      not the first one's cooldown.
    function test_ABatchIsAtomic() public {
        address second = makeAddr("second user");
        uint256 secondToken = pm.mintTo(second, poolKey, -300, -200, LIQUIDITY);
        vm.startPrank(second);
        pm.setApprovalForAll(address(vault), true);
        vault.setMandate(secondToken, mandate);
        vm.stopPrank();

        HelicoVault.RecenterParams memory good = _params();
        HelicoVault.RecenterParams memory bad = _params();
        bad.owner = second;
        bad.tickLower = -100; // wrong width against the committed mandate

        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(
            HelicoVault.recenterWithSignature, (good, MandateLib.hash(mandate), 0, _sign(agentKey, good, 0))
        );
        calls[1] = abi.encodeCall(
            HelicoVault.recenterWithSignature, (bad, MandateLib.hash(mandate), 0, _sign(agentKey, bad, 0))
        );

        vm.prank(relayer);
        vm.expectRevert(HelicoVault.RangeWidthMismatch.selector);
        vault.multicall(calls);

        assertEq(vault.nonces(user), 0, "the good half was rolled back too");
        assertEq(vault.positionOf(user), tokenId, "and nothing moved");
    }

    /// @notice `delegatecall` keeps the caller, so a batched user action is still theirs.
    ///         If it were not, `setMandate` inside a batch would attribute to the vault.
    function test_TheCallerIsPreservedInsideABatch() public {
        uint256 other = pm.mintTo(user, poolKey, -400, -300, LIQUIDITY);

        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeCall(HelicoVault.setMandate, (other, mandate));

        vm.prank(user);
        vault.multicall(calls);

        assertEq(vault.positionOf(user), other, "attributed to the user, not to the vault");
    }

    /// @notice `multicall` takes no value, which is what makes batching safe here.
    /// @dev Batching a payable function with itself lets one `msg.value` be counted by every
    ///      `delegatecall`. The vault has one payable function — `upgradeToAndCall`, from UUPS
    ///      — so what rules the hazard out is this, not their absence.
    ///
    ///      This test proves only that today's `multicall` rejects value; it would keep passing
    ///      if `multicall` were later overridden as payable elsewhere in the hierarchy. The ABI
    ///      is where that can be checked, and `scripts/check-no-payable.py` checks it.
    function test_MulticallTakesNoValue() public {
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeCall(HelicoVault.revoke, ());

        vm.deal(user, 1 ether);
        vm.prank(user);
        (bool ok,) = address(vault).call{value: 1 ether}(abi.encodeWithSignature("multicall(bytes[])", calls));
        assertFalse(ok, "multicall must reject value");
    }

    function test_StrangerCannotForgeByReusingAValidSignatureOnOtherParameters() public {
        HelicoVault.RecenterParams memory p = _params();
        bytes memory sig = _sign(agentKey, p, 0);

        HelicoVault.RecenterParams memory tampered = p;
        tampered.owner = stranger;

        vm.prank(stranger);
        vm.expectRevert();
        vault.recenterWithSignature(tampered, MandateLib.hash(mandate), 0, sig);
    }
}
