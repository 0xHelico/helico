// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// Powered by SwapVM — © Degensoft Ltd 2025
/// @custom:license-url https://github.com/1inch/swap-vm/blob/main/LICENSES/SwapVM-1.1.txt
/// @custom:changes Extends Degensoft's `AquaOpcodes` with one instruction, added by Helico on
///                 8 September 2026. The published table is reproduced unchanged; the addition
///                 is the last entry.

import {Context} from "@1inch/swap-vm/libs/VM.sol";

import {AquaOpcodes} from "@1inch/swap-vm/opcodes/AquaOpcodes.sol";
import {Controls} from "@1inch/swap-vm/instructions/Controls.sol";
import {Decay} from "@1inch/swap-vm/instructions/Decay.sol";
import {Extruction} from "@1inch/swap-vm/instructions/Extruction.sol";
import {Fee} from "@1inch/swap-vm/instructions/Fee.sol";
import {PeggedSwap} from "@1inch/swap-vm/instructions/PeggedSwap.sol";
import {XYCConcentrate} from "@1inch/swap-vm/instructions/XYCConcentrate.sol";
import {XYCSwap} from "@1inch/swap-vm/instructions/XYCSwap.sol";

import {AquaYieldCover} from "./AquaYieldCover.sol";

/// @title HelicoAquaOpcodes
/// @notice Degensoft's Aqua instruction set, plus `_aquaYieldCoverXD` at the opcode
///         `AQUA_YIELD_COVER_OPCODE` names.
///
/// @dev The number is deliberately not repeated here. It said 35 until @rifkyeasy caught it —
///      nine lines above the constant that said 34, in the file whose whole subject is that an
///      opcode is its position minus one. A number written twice is a number that drifts, and
///      this is the one a consumer copies out and builds a program around.
///
/// @dev Appended rather than inserted, which is the rule the published table states in its own
///      comment: *"New instructions should be added at the end to maintain backward
///      compatibility."* Every opcode a program written for the canonical router uses keeps the
///      number it had, so a strategy that does not mention 35 behaves identically here.
///
///      `_opcodes()` is `virtual` in the published contract. This is the extension point as
///      designed, not a way around one.
contract HelicoAquaOpcodes is AquaOpcodes, AquaYieldCover {
    /// @notice The opcode `_aquaYieldCoverXD` answers to.
    /// @dev Public because a program is bytes, and a caller assembling one off-chain should read
    ///      this number from the deployment rather than copying it into a constant that then
    ///      drifts from the contract it indexes.
    ///
    ///      **It is 34 and not 35, and the reason is worth writing down.** The table below is a
    ///      static array turned into a dynamic one by overwriting its first word with the length,
    ///      which is what the assembly at the bottom does. That word held entry zero, so entry
    ///      zero is consumed and every opcode is its position in the source **minus one**. Read
    ///      off the source directly and a program calls the instruction next door: opcode 18 is
    ///      not `_xycSwapXD` where it appears to be, it is `_xycConcentrateGrowLiquidity2D`, and
    ///      the only symptom is a revert from a curve nobody asked for.
    uint256 public constant AQUA_YIELD_COVER_OPCODE = 34;

    constructor(address aqua) AquaOpcodes(aqua) AquaYieldCover(aqua) {}

    function _opcodes()
        internal
        pure
        override
        returns (function(Context memory, bytes calldata) internal[] memory result)
    {
        function(Context memory, bytes calldata) internal[36] memory instructions = [
            _notInstruction,
            _notInstruction,
            _notInstruction,
            _notInstruction,
            _notInstruction,
            _notInstruction,
            _notInstruction,
            _notInstruction,
            _notInstruction,
            _notInstruction,
            _notInstruction,
            Controls._jump,
            Controls._jumpIfTokenIn,
            Controls._jumpIfTokenOut,
            Controls._deadline,
            Controls._onlyTakerTokenBalanceNonZero,
            Controls._onlyTakerTokenBalanceGte,
            Controls._onlyTakerTokenSupplyShareGte,
            XYCSwap._xycSwapXD,
            XYCConcentrate._xycConcentrateGrowLiquidity2D,
            Decay._decayXD,
            Controls._salt,
            Fee._flatFeeAmountInXD,
            _notInstruction,
            _notInstruction,
            _notInstruction,
            _notInstruction,
            _notInstruction,
            Fee._protocolFeeAmountInXD,
            Fee._aquaProtocolFeeAmountInXD,
            Fee._dynamicProtocolFeeAmountInXD,
            Fee._aquaDynamicProtocolFeeAmountInXD,
            PeggedSwap._peggedSwapGrowPriceRange2D,
            Extruction._extruction,
            Controls._onlyTxOriginTokenBalanceNonZero,
            // ─── Helico ───────────────────────────────────────────────────────────────
            AquaYieldCover._aquaYieldCoverXD
        ];

        uint256 instructionsArrayLength = instructions.length - 1;
        assembly ("memory-safe") {
            result := instructions
            mstore(result, instructionsArrayLength)
        }
    }
}
