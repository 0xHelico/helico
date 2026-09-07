// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {HelicoAccount} from "../src/HelicoAccount.sol";
import {HelicoAccountFactory} from "../src/HelicoAccountFactory.sol";

/// @notice Deploys the account implementation and the factory that opens accounts from it.
///
/// @dev Two contracts, one order, and the order matters: the factory takes the implementation as
///      an immutable, so pointing new accounts at different code means deploying a new factory.
///      That is deliberate — a re-pointable factory would let one key change what every future
///      account is born as, and existing owners would have no way to see it had happened.
///
///      **Nothing is initialised and nothing is owned here.** The implementation holds one
///      immutable and no state; each account's owner is fixed in its own proxy's bytecode at the
///      moment it is opened. So there is no window between deployment and initialisation in which
///      a contract could be claimed, and the deployer keeps no authority over what it deployed.
///
///      Run:
///        forge script script/DeployAccountFactory.s.sol:DeployAccountFactory \
///          --rpc-url $ARBITRUM_RPC_URL --broadcast --account helico-deployer
///
///      Environment:
///        ACCOUNT_UPGRADER  the key allowed to upgrade accounts without the owner acting — the
///                          CRE enclave. Defaults to zero, which means only owners ever change
///                          their own account's code. Set it deliberately or leave it unset;
///                          there is no sensible guess to make here on someone's behalf.
contract DeployAccountFactory is Script {
    uint256 internal constant ARBITRUM_ONE = 42161;

    error WrongChain(uint256 actual);
    error FactoryPointsElsewhere(address expected, address actual);
    error AddressIsNotDeterministic(address predicted, address actual);

    function run() external returns (HelicoAccount implementation, HelicoAccountFactory factory) {
        if (block.chainid != ARBITRUM_ONE) revert WrongChain(block.chainid);

        address upgrader = vm.envOr("ACCOUNT_UPGRADER", address(0));

        vm.startBroadcast();
        (implementation, factory) = deploy(upgrader);
        vm.stopBroadcast();

        _check(implementation, factory);

        console.log("account implementation ", address(implementation));
        console.log("account factory        ", address(factory));
        console.log("upgrader               ", upgrader);
        console.log("chain                  ", block.chainid);
        if (upgrader == address(0)) {
            console.log("note: no upgrader set - only owners can change their own account's code");
        }
    }

    /// @dev Public so the fork test deploys through the same call the broadcast uses. A rehearsal
    ///      through a door production does not use is not a rehearsal.
    function deploy(address upgrader) public returns (HelicoAccount implementation, HelicoAccountFactory factory) {
        implementation = new HelicoAccount(upgrader);
        factory = new HelicoAccountFactory(address(implementation));
    }

    /// @dev Two things worth failing the deployment over, checked after the broadcast rather than
    ///      assumed. The first is that the factory points at the implementation we just made. The
    ///      second is that the address it predicts for an owner is the address it actually
    ///      produces — the counterfactual promise is the whole reason this is a factory, and it
    ///      would be a quiet lie if the init code and the prediction ever disagreed.
    function _check(HelicoAccount implementation, HelicoAccountFactory factory) internal {
        if (factory.IMPLEMENTATION() != address(implementation)) {
            revert FactoryPointsElsewhere(address(implementation), factory.IMPLEMENTATION());
        }

        address probe = address(uint160(uint256(keccak256("helico.deploy.probe"))));
        address predicted = factory.accountFor(probe);
        uint256 snapshot = vm.snapshotState();
        address actual = factory.open(probe);
        vm.revertToState(snapshot);
        if (predicted != actual) revert AddressIsNotDeterministic(predicted, actual);
    }
}
