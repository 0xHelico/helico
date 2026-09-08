// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// Powered by SwapVM — © Degensoft Ltd 2025
/// @custom:license-url https://github.com/1inch/swap-vm/blob/main/LICENSES/SwapVM-1.1.txt
/// @custom:changes Redeployment of Degensoft's `AquaSwapVMRouter` carrying one added
///                 instruction. Helico, 8 September 2026.

import {Simulator} from "@1inch/solidity-utils/contracts/mixins/Simulator.sol";

import {Context} from "@1inch/swap-vm/libs/VM.sol";
import {SwapVM} from "@1inch/swap-vm/SwapVM.sol";

import {HelicoAquaOpcodes} from "./HelicoAquaOpcodes.sol";

/// @title HelicoAquaSwapVMRouter
/// @notice Degensoft's `AquaSwapVMRouter`, with `_aquaYieldCoverXD` in its instruction set.
///
/// @dev The published qualification for this is explicit — *"redeployments of a modified SwapVM
///      contract is allowed"* — and this is one: the VM, the transfer phase, the Aqua accounting
///      and every published instruction are theirs and unchanged. What is ours is opcode 35 and
///      the fact that this address, rather than the canonical router, is the Aqua app a maker
///      ships to.
///
///      That last part is the authority the added instruction needs. `Aqua.pull` is keyed on
///      `msg.sender` as the app, so only a router a maker deliberately shipped to can spend that
///      maker's receipt — and only under the strategy hash they shipped it under.
contract HelicoAquaSwapVMRouter is Simulator, SwapVM, HelicoAquaOpcodes {
    constructor(address aqua, address weth, address owner, string memory name, string memory version)
        SwapVM(aqua, weth, owner, name, version)
        HelicoAquaOpcodes(aqua)
    {}

    function _instructions()
        internal
        pure
        override
        returns (function(Context memory, bytes calldata) internal[] memory result)
    {
        return _opcodes();
    }
}
