// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {HelicoVault} from "../src/HelicoVault.sol";

/// @notice Deploys `HelicoVault` behind a proxy that is initialised in the same transaction.
///
/// @dev **Why one transaction.** A proxy deployed uninitialised can be initialised by whoever
///      reaches it first, and `initialize` hands out `DEFAULT_ADMIN_ROLE`. Passing the call
///      into the `ERC1967Proxy` constructor removes that window entirely rather than narrowing
///      it. The twelve-agent audit left this open as a lead precisely because no deploy script
///      existed to answer it.
///
///      Run:
///        forge script script/Deploy.s.sol:Deploy --rpc-url $ARBITRUM_RPC_URL --broadcast
///
///      Environment:
///        AGENT_ADDRESS     the enclave's signer. Not an EOA we hold — the key exists only
///                          inside the enclave, which is the whole point of the signature path.
///        ADMIN_ADDRESS     optional; defaults to the broadcaster. Should be a multisig.
///        FORWARDER_ADDRESS optional; the Chainlink CRE `KeystoneForwarder` whose reports the
///                          vault will honour. Left unset the report path is simply off, and an
///                          admin can point the vault at one later without a redeploy — which
///                          is how the same deployment moves from the CLI's mock forwarder to
///                          the production one.
contract Deploy is Script {
    uint256 constant ARBITRUM_ONE = 42161;

    // Arbitrum One. These resolve from `@uniswap/sdk-core`'s own address map — they are
    // written out here so the script depends on nothing that could change under it, and each
    // was checked to have code before this was committed.
    address constant POSITION_MANAGER = 0xd88F38F930b7952f2DB2432Cb002E7abbF3dD869;
    address constant STATE_VIEW = 0x76Fd297e2D437cd7f76d50F01AfE6160f86e9990;
    address constant POOL_MANAGER = 0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32;

    error WrongChain(uint256 actual);
    error NoAgentAddress();
    error NoAdminAddress();
    error DependencyHasNoCode(address dependency);

    function run() external returns (HelicoVault vault) {
        // A mainnet script that will run anywhere is a mainnet script that will eventually run
        // somewhere else.
        if (block.chainid != ARBITRUM_ONE) revert WrongChain(block.chainid);

        address agent = vm.envAddress("AGENT_ADDRESS");
        if (agent == address(0)) revert NoAgentAddress();

        // The address that will actually sign, resolved the way Foundry resolves it. Not
        // `address(this)`: a script contract is ephemeral, Foundry refuses to let its address
        // be relied on, and every call below is broadcast from the wallet rather than from here.
        address deployer = msg.sender;
        address admin = vm.envOr("ADMIN_ADDRESS", deployer);
        if (admin == address(0)) revert NoAdminAddress();

        address forwarder = vm.envOr("FORWARDER_ADDRESS", address(0));

        // The addresses above are constants, so this catches a chain that answers with the
        // right id but is not the chain we think it is.
        _requireCode(POSITION_MANAGER);
        _requireCode(STATE_VIEW);
        _requireCode(POOL_MANAGER);

        vm.startBroadcast();
        vault = _deploy(deployer, admin, agent, forwarder);
        vm.stopBroadcast();

        console.log("vault (proxy)  ", address(vault));
        console.log("admin          ", admin);
        console.log("agent (enclave)", agent);
        console.log("forwarder      ", forwarder);
        console.log("chain          ", block.chainid);
    }

    /// @dev The deployment itself, taking the deployer explicitly so it works both under a
    ///      broadcast (where the caller is the wallet) and in a fork test (where it is the test
    ///      contract). The first version took `address(this)`, which Foundry rejects outright
    ///      inside a broadcast — and the fork test could not catch it, because calling `deploy`
    ///      externally makes `address(this)` the script rather than the sender. A rehearsal
    ///      through a door production does not use is not a rehearsal.
    ///
    ///      The deployer holds the admin role only for the length of this sequence: it grants
    ///      the three roles, passes the admin role on, and renounces its own. Note that a
    ///      broadcast is a signed *sequence*, not one transaction, so those steps land in
    ///      separate blocks — the deployer is briefly the sole admin, which is why it should be
    ///      a key you control and discard, and why `ADMIN_ADDRESS` should be a multisig.
    function _deploy(address deployer, address admin, address agent, address forwarder)
        internal
        returns (HelicoVault vault)
    {
        HelicoVault implementation = new HelicoVault();
        vault = HelicoVault(
            payable(address(
                    new ERC1967Proxy(
                        address(implementation),
                        abi.encodeCall(
                            HelicoVault.initialize, (deployer, POSITION_MANAGER, STATE_VIEW, POOL_MANAGER)
                        )
                    )
                ))
        );

        // The enclave is the only thing that may propose an action. Its key exists nowhere
        // else, which is why this is not an address we hold.
        vault.grantRole(vault.AGENT_ROLE(), agent);
        vault.grantRole(vault.GUARDIAN_ROLE(), admin);
        vault.grantRole(vault.UPGRADER_ROLE(), admin);

        // Set while the deployer still holds the admin role, so a deployment that wants the
        // report path does not need a second, separately-authorised transaction later.
        if (forwarder != address(0)) vault.setForwarder(forwarder);

        bytes32 adminRole = vault.DEFAULT_ADMIN_ROLE();
        vault.grantRole(adminRole, admin);
        if (admin != deployer) vault.renounceRole(adminRole, deployer);

        console.log("implementation ", address(implementation));
    }

    /// @dev Kept for fork tests, which call it as the deployer themselves.
    function deploy(address admin, address agent, address forwarder) public returns (HelicoVault) {
        return _deploy(address(this), admin, agent, forwarder);
    }

    function _requireCode(address dependency) internal view {
        if (dependency.code.length == 0) revert DependencyHasNoCode(dependency);
    }
}
