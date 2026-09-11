// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";

import {HelicoAgent} from "../src/HelicoAgent.sol";
import {HelicoAppProxy} from "../src/HelicoAppProxy.sol";
import {IReceiver} from "../src/IReceiver.sol";

interface ITypeAndVersion {
    function typeAndVersion() external view returns (string memory);
}

/// @notice The agent contract, behind a proxy, pinned to the production forwarder and to the key
///         that deploys Helico's workflows.
///
/// @dev **The forwarder is asked what it is before anything is deployed against it.** The CRE
///      forwarder directory lists two addresses for Arbitrum One — the production
///      `KeystoneForwarder` and the `MockKeystoneForwarder` that `cre workflow simulate --broadcast`
///      uses — and the CLI's `supported-chains` prints the production one under a column headed
///      "MOCK FORWARDER". A receiver pinned to the mock accepts unsigned reports from anyone who
///      can call it; a receiver pinned to production refuses the simulator. Both deploy cleanly.
///      So the address is not trusted from any table: the chain is asked for `typeAndVersion()`
///      and the string has to say `KeystoneForwarder`, not `Mock`.
///
///      **Deploying is not the last step**, and the account is the one that decides. Until the
///      owner calls `setAgent(<proxy>)` the DON's reports revert at the account with
///      `NotOwnerOrAgent`, which is the right outcome for a contract nobody nominated. Then
///      `config.production.json` names the proxy as both `reportReceiver` and `agent`, switches
///      `delivery` to `forwarder`, and the workflow is redeployed with that config.
///
///      Run:
///        forge script script/DeployHelicoAgent.s.sol:DeployHelicoAgent \
///          --rpc-url $ARBITRUM_RPC_URL --broadcast --verify --private-key "$KEY"
///
///      Environment:
///        FORWARDER        Defaults to the production KeystoneForwarder on Arbitrum One.
///        WORKFLOW_OWNER   Defaults to the CRE workflow owner (the deployer key).
///        AGENT_UPGRADER   Defaults to the same upgrader as the mandate swap and the account.
contract DeployHelicoAgent is Script {
    uint256 constant ARBITRUM_ONE = 42161;

    /// @dev `KeystoneForwarder 1.0.0` at the address the CRE forwarder directory gives for
    ///      `ethereum-mainnet-arbitrum-1`. Confirmed on chain before use, below.
    address public constant FORWARDER = 0xF8344CFd5c43616a4366C34E3EEE75af79a74482;
    /// @dev `cre secrets update` prints it: `owner=0x6DCd…439E, linked=true`. Also the deployer.
    address public constant WORKFLOW_OWNER = 0x6DCd7485aB17e0CBD0723b8435a35bb8d029439E;
    address public constant DEFAULT_UPGRADER = 0xaeE1F9d2c23730CA04Dd478830c2acc495536E9C;

    error WrongChain(uint256 actual);
    error NoCode(address target);
    error NotTheProductionForwarder(address target, string answered);
    error ProbeFails(address proxy);
    error ReadsBackWrong(string what);

    function run() external returns (HelicoAgent agent) {
        if (block.chainid != ARBITRUM_ONE) revert WrongChain(block.chainid);

        address forwarder = vm.envOr("FORWARDER", FORWARDER);
        address workflowOwner = vm.envOr("WORKFLOW_OWNER", WORKFLOW_OWNER);
        address upgrader = vm.envOr("AGENT_UPGRADER", DEFAULT_UPGRADER);

        if (forwarder.code.length == 0) revert NoCode(forwarder);
        string memory kind = ITypeAndVersion(forwarder).typeAndVersion();
        if (keccak256(bytes(kind)) != keccak256("KeystoneForwarder 1.0.0")) {
            revert NotTheProductionForwarder(forwarder, kind);
        }

        vm.startBroadcast();
        HelicoAgent implementation = new HelicoAgent(forwarder, workflowOwner, upgrader);
        agent = HelicoAgent(address(new HelicoAppProxy(address(implementation))));
        vm.stopBroadcast();

        // The forwarder's own probe, through the proxy, before anyone is told the address.
        if (!ERC165Checker.supportsInterface(address(agent), type(IReceiver).interfaceId)) {
            revert ProbeFails(address(agent));
        }
        if (agent.FORWARDER() != forwarder) revert ReadsBackWrong("FORWARDER");
        if (agent.WORKFLOW_OWNER() != workflowOwner) revert ReadsBackWrong("WORKFLOW_OWNER");
        if (agent.UPGRADER() != upgrader) revert ReadsBackWrong("UPGRADER");

        console.log("HelicoAgent (proxy)          ", address(agent));
        console.log("HelicoAgent (implementation) ", address(implementation));
        console.log("forwarder                    ", forwarder, kind);
        console.log("workflow owner               ", workflowOwner);
        console.log("upgrader                     ", upgrader);
        console.log("next: owner calls setAgent(proxy); config names it as reportReceiver and agent");
    }
}
