// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IAqua} from "@1inch/aqua/interfaces/IAqua.sol";

import {HelicoMandateSwap} from "../src/HelicoMandateSwap.sol";
import {HelicoTaker} from "../src/HelicoTaker.sol";

/// @notice The taker anyone can use, over the live `HelicoMandateSwap`.
///
/// @dev Both addresses are asked to agree before anything is deployed: the app must answer
///      `AQUA()` with the Aqua this taker will push to, or every fill would pay the wrong ledger
///      and revert at the app's own verification — after the gas.
///
///      Run:
///        forge script script/DeployHelicoTaker.s.sol:DeployHelicoTaker \
///          --rpc-url $ARBITRUM_RPC_URL --broadcast --verify --private-key "$KEY"
contract DeployHelicoTaker is Script {
    uint256 constant ARBITRUM_ONE = 42161;

    /// @dev The canonical Aqua on Arbitrum One, the one `@1inch/aqua-sdk` names.
    address public constant AQUA = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;
    /// @dev `HelicoMandateSwap`, the 10 September proxy in `docs/deployments.md`.
    address public constant APP = 0x0524a353dfab33CD362593ae8e97707764Fb6041;

    error WrongChain(uint256 actual);
    error NoCode(address target);
    error AppOnAnotherAqua(address answered, address expected);

    function run() external returns (HelicoTaker taker) {
        if (block.chainid != ARBITRUM_ONE) revert WrongChain(block.chainid);
        if (AQUA.code.length == 0) revert NoCode(AQUA);
        if (APP.code.length == 0) revert NoCode(APP);
        address answered = address(HelicoMandateSwap(APP).AQUA());
        if (answered != AQUA) revert AppOnAnotherAqua(answered, AQUA);

        vm.startBroadcast();
        taker = new HelicoTaker(IAqua(AQUA), HelicoMandateSwap(APP));
        vm.stopBroadcast();

        if (address(taker.AQUA()) != AQUA || address(taker.APP()) != APP) revert NoCode(address(taker));
        console.log("HelicoTaker", address(taker));
    }
}
