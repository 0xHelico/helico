// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {HelicoAquaSwapVMRouter} from "../src/swapvm/HelicoAquaSwapVMRouter.sol";

/// @notice Deploys the SwapVM router that carries `_aquaYieldCoverXD`.
///
/// @dev **This is a redeployment, not a fork of the protocol.** Degensoft's `AquaSwapVMRouter`
///      with one instruction appended, which their licence permits in as many words. It talks to
///      the same Aqua every other Aqua app talks to; what makes it a different address is the
///      instruction, not a different ledger.
///
///      **The mistake this deployment invites.** A maker ships to an *app address*, and Aqua
///      keys every balance by it. Ship to the canonical router and the program's opcode 34 is
///      whatever that router has at 34 — which is nothing, so the swap reverts on an out-of-range
///      instruction and the maker is left with a live commitment against a strategy nobody can
///      fill. Ship to this address instead. The runbook says it twice for the same reason.
///
///      **What the checks below can and cannot prove.** They prove this router points at the
///      canonical Aqua and the canonical WETH, that it has code, and that it reports the opcode
///      the off-chain program builder is expected to emit. They cannot prove that opcode 34 is
///      the instruction we think it is: that needs a swap to actually run, and the thing that
///      proves it is `test/ForkSwapVMYieldCover.t.sol`, which does exactly that against a fork of
///      this chain. A deploy script that claimed more would be claiming it without measuring.
///
///      Run:
///        FOUNDRY_PROFILE=swapvm forge script script/DeploySwapVMRouter.s.sol:DeploySwapVMRouter \
///          --rpc-url $ARBITRUM_RPC_URL --broadcast --private-key "$KEY"
///
///      The profile is not optional. SwapVM does not compile without the IR pipeline, and the
///      default profile does not compile these files at all.
///
///      Environment:
///        SWAPVM_RESCUER  the address allowed to rescue tokens stranded in the router — the only
///                        authority this contract has. Defaults to zero, which means nobody can,
///                        and stranded tokens stay stranded. Set it deliberately.
contract DeploySwapVMRouter is Script {
    uint256 internal constant ARBITRUM_ONE = 42161;

    /// @dev Read from `@1inch/aqua-sdk` and confirmed against the deployed `AquaSwapVMRouter`'s
    ///      bytecode. Not the address found by scanning for a contract that emits Aqua's events —
    ///      that search returns a real, retired Aqua, and it did once. See issue #165.
    address internal constant AQUA = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;
    address internal constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;

    /// @dev Only reachable through signature-based orders, which this router is not deployed for
    ///      — an Aqua order hashes as `keccak256(abi.encode(order))` and never touches the EIP-712
    ///      domain. Named rather than left blank so the two paths are not silently the same.
    string internal constant DOMAIN_NAME = "Helico SwapVM";
    string internal constant DOMAIN_VERSION = "1";

    error WrongChain(uint256 actual);
    error RouterPointsAtAnotherAqua(address expected, address actual);
    error OpcodeIsNotWhereTheBuilderExpects(uint256 expected, uint256 actual);
    error RouterHasNoCode();

    function run() external returns (HelicoAquaSwapVMRouter router) {
        if (block.chainid != ARBITRUM_ONE) revert WrongChain(block.chainid);

        address rescuer = vm.envOr("SWAPVM_RESCUER", address(0));

        vm.startBroadcast();
        router = deploy(rescuer);
        vm.stopBroadcast();

        _check(router);

        console.log("swapvm router          ", address(router));
        console.log("aqua                   ", AQUA);
        console.log("weth                   ", WETH);
        console.log("rescuer                ", rescuer);
        console.log("yield-cover opcode     ", router.AQUA_YIELD_COVER_OPCODE());
        console.log("chain                  ", block.chainid);
        console.log("ship strategies to the router address above, not to 1inch's");
        if (rescuer == address(0)) {
            console.log("note: no rescuer set - tokens stranded in the router stay stranded");
        }
    }

    /// @dev Public so a fork test deploys through the same call a broadcast uses. A rehearsal
    ///      through a door production does not use is not a rehearsal.
    function deploy(address rescuer) public returns (HelicoAquaSwapVMRouter router) {
        router = new HelicoAquaSwapVMRouter(AQUA, WETH, rescuer, DOMAIN_NAME, DOMAIN_VERSION);
    }

    function _check(HelicoAquaSwapVMRouter router) internal view {
        if (address(router).code.length == 0) revert RouterHasNoCode();
        if (address(router.AQUA()) != AQUA) {
            revert RouterPointsAtAnotherAqua(AQUA, address(router.AQUA()));
        }
        // 34 and not 35, because the instruction table is a static array turned dynamic by
        // overwriting its first word with the length — so every opcode is its position in the
        // source minus one. An off-chain builder that emits 35 calls nothing and reverts.
        if (router.AQUA_YIELD_COVER_OPCODE() != 34) {
            revert OpcodeIsNotWhereTheBuilderExpects(34, router.AQUA_YIELD_COVER_OPCODE());
        }
    }
}
