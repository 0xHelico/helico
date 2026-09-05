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
///        forge script script/Deploy.s.sol:Deploy --rpc-url $ROBINHOOD_RPC_URL --broadcast
///
///      Environment:
///        AGENT_ADDRESS   the enclave's signer. Not an EOA we hold — the key exists only
///                        inside the enclave, which is the whole point of the signature path.
///        ADMIN_ADDRESS   optional; defaults to the broadcaster. Should be a multisig.
contract Deploy is Script {
    uint256 constant ROBINHOOD_MAINNET = 4663;

    // Verified on chain rather than copied from a table: each has code at these addresses.
    address constant POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address constant STATE_VIEW = 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    error WrongChain(uint256 actual);
    error NoAgentAddress();
    error DependencyHasNoCode(address dependency);

    function run() external returns (HelicoVault vault) {
        // A mainnet script that will run anywhere is a mainnet script that will eventually run
        // somewhere else.
        if (block.chainid != ROBINHOOD_MAINNET) revert WrongChain(block.chainid);

        address agent = vm.envAddress("AGENT_ADDRESS");
        if (agent == address(0)) revert NoAgentAddress();
        address admin = vm.envOr("ADMIN_ADDRESS", msg.sender);

        // The addresses above are constants, so this catches a chain that answers with the
        // right id but is not the chain we think it is.
        _requireCode(POSITION_MANAGER);
        _requireCode(STATE_VIEW);
        _requireCode(POOL_MANAGER);

        vm.startBroadcast();
        vault = deploy(admin, agent);
        vm.stopBroadcast();

        console.log("vault (proxy)  ", address(vault));
        console.log("admin          ", admin);
        console.log("agent (enclave)", agent);
        console.log("chain          ", block.chainid);
    }

    /// @dev The deployment itself, separated from `run` so a fork test can rehearse it. A
    ///      script nobody has run is the same as no script — and the first rehearsal of this
    ///      one failed, because it granted roles it did not hold.
    ///
    ///      So it takes the admin role itself, hands out the three roles, passes the admin role
    ///      on, and renounces its own. The deployer keeps nothing. Every step is in the same
    ///      broadcast, so there is no window in which the contract exists with an admin nobody
    ///      intended.
    function deploy(address admin, address agent) public returns (HelicoVault vault) {
        HelicoVault implementation = new HelicoVault();
        vault = HelicoVault(
            payable(address(
                    new ERC1967Proxy(
                        address(implementation),
                        abi.encodeCall(
                            HelicoVault.initialize,
                            (address(this), POSITION_MANAGER, STATE_VIEW, POOL_MANAGER)
                        )
                    )
                ))
        );

        // The enclave is the only thing that may propose an action. Its key exists nowhere
        // else, which is why this is not an address we hold.
        vault.grantRole(vault.AGENT_ROLE(), agent);
        vault.grantRole(vault.GUARDIAN_ROLE(), admin);
        vault.grantRole(vault.UPGRADER_ROLE(), admin);

        bytes32 adminRole = vault.DEFAULT_ADMIN_ROLE();
        vault.grantRole(adminRole, admin);
        if (admin != address(this)) vault.renounceRole(adminRole, address(this));

        console.log("implementation ", address(implementation));
    }

    function _requireCode(address dependency) internal view {
        if (dependency.code.length == 0) revert DependencyHasNoCode(dependency);
    }
}
