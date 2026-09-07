// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {IAqua} from "@1inch/aqua/interfaces/IAqua.sol";

import {HelicoMandateSwap} from "../src/HelicoMandateSwap.sol";

/// @notice Deploys `HelicoMandateSwap` against a live Aqua.
///
/// @dev **No proxy, and nothing to initialise.** The app holds no state of its own — every
///      mandate lives in Aqua's ledger, keyed by its hash — so there is no storage to lay out,
///      no admin role to hand over, and no window in which an uninitialised contract could be
///      claimed. The one immutable it has is set in the constructor. That is the whole
///      deployment.
///
///      Run:
///        forge script script/DeployMandateSwap.s.sol:DeployMandateSwap \
///          --rpc-url $ARBITRUM_RPC_URL --broadcast --account helico-deployer
///
///      Environment:
///        AQUA_ADDRESS  optional; defaults to the canonical deployment below. Set it only to
///                      point at a different Aqua, which in practice means a local one.
contract DeployMandateSwap is Script {
    uint256 constant ARBITRUM_ONE = 42161;

    /// @dev The address 1inch names as canonical, confirmed by them directly in `#partner-1inch`
    ///      and published in their README: *"Only interact with these two contracts. Anything
    ///      else is not Aqua."*
    ///
    ///      This was `0x499943E7…` until 8 September, taken from the README inside the `v1.0.0`
    ///      tag we vendor. That tag is from March and its README is stale; `main` lists this one.
    ///      Both addresses hold code and both answer `rawBalances` for an unknown strategy, so
    ///      behaviour cannot tell them apart — which is why the check below is necessary and
    ///      also why it was not sufficient.
    ///
    ///      What separates them: their bytecode differs (11,241 vs 12,505), and the stale one
    ///      carries 1,289 events on Arbitrum while this one carries **none**. Activity was the
    ///      misleading signal here. The partner's own word is the deciding one.
    ///
    ///      Note that `forge fmt` rewrites an address literal's EIP-55 checksum to match
    ///      whatever hex is there, so a mistyped address compiles cleanly with a valid
    ///      checksum. solc's protection is gone the moment the formatter runs. The fork test
    ///      is what actually holds this constant to the chain.
    address public constant AQUA = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;

    error WrongChain(uint256 actual);
    error AquaHasNoCode(address aqua);
    error NotAqua(address aqua);

    function run() external returns (HelicoMandateSwap app) {
        if (block.chainid != ARBITRUM_ONE) revert WrongChain(block.chainid);

        address aqua = vm.envOr("AQUA_ADDRESS", AQUA);
        _requireAqua(aqua);

        vm.startBroadcast();
        app = deploy(IAqua(aqua));
        vm.stopBroadcast();

        console.log("mandate swap ", address(app));
        console.log("aqua         ", aqua);
        console.log("chain        ", block.chainid);
    }

    /// @dev Public so the fork test deploys through the same call the broadcast uses. A
    ///      rehearsal through a door production does not use is not a rehearsal.
    function deploy(IAqua aqua) public returns (HelicoMandateSwap) {
        return new HelicoMandateSwap(aqua);
    }

    /// @dev Code at the address is not enough — a wrong address on the right chain would pass
    ///      that and fail on the first swap. Aqua answers `rawBalances` for any arguments at
    ///      all, including a strategy nobody has shipped, so a successful call is a cheap and
    ///      specific signal that this is the interface we think it is.
    function _requireAqua(address aqua) internal view {
        if (aqua.code.length == 0) revert AquaHasNoCode(aqua);
        try IAqua(aqua).rawBalances(address(1), address(2), bytes32(uint256(3)), address(4)) returns (
            uint248, uint8
        ) {
            return;
        } catch {
            revert NotAqua(aqua);
        }
    }
}
