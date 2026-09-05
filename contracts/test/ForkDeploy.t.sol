// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./ForkBase.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {HelicoVault} from "../src/HelicoVault.sol";

/// @notice Rehearses the mainnet deployment against a fork of the chain it targets.
///
/// @dev A deploy script nobody has run is the same as no deploy script, and the first time to
///      find out that a dependency address is wrong is not while paying mainnet gas with the
///      deadline in sight.
contract ForkDeployTest is ForkBase {
    Deploy script;

    address admin = makeAddr("admin");
    address enclave = makeAddr("enclave signer");

    function test_DeploysAnInitialisedVaultAgainstTheRealChain() public {
        _fork();
        script = new Deploy();

        HelicoVault vault = script.deploy(admin, enclave);

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

        // The EIP-712 domain has to match what the enclave signs against, and it binds this
        // chain and this address — so it can only be checked once deployed.
        (, string memory name, string memory version, uint256 chainId, address verifying,,) =
            vault.eip712Domain();
        assertEq(name, "HelicoVault");
        assertEq(version, "1");
        assertEq(chainId, ROBINHOOD_MAINNET, "the domain binds the chain it was deployed to");
        assertEq(verifying, address(vault), "and the address it lives at");
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
