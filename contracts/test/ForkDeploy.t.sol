// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ArbitrumFork} from "./ForkBase.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {HelicoVault} from "../src/HelicoVault.sol";

/// @notice Rehearses the mainnet deployment against a fork of the chain it targets.
///
/// @dev A deploy script nobody has run is the same as no deploy script, and the first time to
///      find out that a dependency address is wrong is not while paying mainnet gas with the
///      deadline in sight.
contract ForkDeployTest is ArbitrumFork {
    Deploy script;

    address admin = makeAddr("admin");
    address enclave = makeAddr("enclave signer");
    /// @dev The production `KeystoneForwarder` on Arbitrum One, checked to have code by
    ///      `packages/plugins/cre`. Passed here so the deploy sequence's own setter runs.
    address forwarder = 0xF8344CFd5c43616a4366C34E3EEE75af79a74482;

    function test_DeploysAnInitialisedVaultAgainstTheRealChain() public {
        _fork();
        script = new Deploy();

        // A distinct deployer, so the handover is exercised rather than skipped. The first
        // version of this test used `deploy(admin, enclave)` with the script itself as the
        // implicit deployer, which is exactly why it could not catch that `run()` was refused
        // outright by Foundry for relying on `address(this)`.
        HelicoVault vault = script.deploy(admin, enclave, forwarder);

        // Wired to the real periphery, not to whatever was in the constructor's comment.
        assertEq(address(vault.positionManager()), address(POSITION_MANAGER), "position manager");
        assertEq(address(vault.stateView()), address(STATE_VIEW), "state view");
        assertEq(address(vault.poolManager()), address(POOL_MANAGER), "pool manager");

        // Initialised in the same transaction as the proxy, so there was never a window in
        // which somebody else could have claimed the admin role.
        vm.expectRevert();
        vault.initialize(admin, address(POSITION_MANAGER), address(STATE_VIEW), address(POOL_MANAGER));

        assertTrue(vault.hasRole(vault.DEFAULT_ADMIN_ROLE(), admin), "admin");
        assertTrue(vault.hasRole(vault.AGENT_ROLE(), enclave), "the enclave may propose");
        assertFalse(vault.hasRole(vault.AGENT_ROLE(), admin), "and the admin may not, by default");

        // Set inside the deploy sequence, while the deployer still held the admin role.
        assertEq(vault.forwarder(), forwarder, "the CRE forwarder the vault will honour");

        // The EIP-712 domain has to match what the enclave signs against, and it binds this
        // chain and this address — so it can only be checked once deployed.
        (, string memory name, string memory version, uint256 chainId, address verifying,,) =
            vault.eip712Domain();
        assertEq(name, "HelicoVault");
        assertEq(version, "1");
        assertEq(chainId, expectedChainId, "the domain binds the chain it was deployed to");
        assertEq(verifying, address(vault), "and the address it lives at");
    }

    /// @notice The deployer must not keep the admin role when a separate admin is named.
    /// @dev The handover is three calls at the end of the sequence and the one place the script
    ///      can leave the contract governed by the wrong party. It is asserted here rather than
    ///      assumed, because the anvil rehearsal defaults `ADMIN_ADDRESS` to the deployer and so
    ///      never exercises the renounce.
    function test_DeployerKeepsNothingWhenTheAdminIsSomebodyElse() public {
        _fork();
        script = new Deploy();

        HelicoVault vault = script.deploy(admin, enclave, forwarder);
        bytes32 adminRole = vault.DEFAULT_ADMIN_ROLE();

        assertTrue(vault.hasRole(adminRole, admin), "the named admin holds it");
        assertFalse(vault.hasRole(adminRole, address(script)), "and the deployer does not");
        assertFalse(vault.hasRole(vault.UPGRADER_ROLE(), address(script)), "nor may it upgrade");
        assertFalse(vault.hasRole(vault.GUARDIAN_ROLE(), address(script)), "nor pause");
        assertFalse(vault.hasRole(vault.AGENT_ROLE(), address(script)), "nor act");
    }

    /// @notice A mainnet script that runs anywhere is one that eventually runs somewhere else.
    function test_RefusesToRunOnAnotherChain() public {
        _fork();
        script = new Deploy();

        vm.chainId(1);
        vm.setEnv("AGENT_ADDRESS", vm.toString(enclave));
        vm.expectRevert(abi.encodeWithSelector(Deploy.WrongChain.selector, uint256(1)));
        script.run();
    }
}
