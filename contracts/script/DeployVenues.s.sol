// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {CompoundVenue, ReserveData} from "../src/CompoundVenue.sol";
import {MorphoVenue} from "../src/MorphoVenue.sol";
import {IComet} from "../src/IComet.sol";
import {IERC4626Vault} from "../src/IERC4626Vault.sol";

/// @notice Deploys the two venues that let the enclave compare markets outside the Aave family.
///
/// @dev **What these are.** `ILendingVenue` carries Aave v3's own signatures, so Aave needs no
///      adapter and everything else does. These two answer that interface on behalf of Compound v3
///      and of any ERC-4626 vault — a Morpho vault being the first one pointed at.
///
///      **The check that matters most is that all three agree about the asset.** A venue over a
///      market denominated in a different USDC would deploy cleanly, answer every read, and make
///      the enclave compare positions in two different tokens as though they were one. Arbitrum
///      has exactly that trap: `cUSDCv3` is native USDC and `cUSDCev3` is the bridged USDC.e. So
///      the base token and the vault asset are read from the chain and compared before anything
///      is broadcast, rather than trusted from a constant.
///
///      **Deploying is not the last step.** A venue nobody has permitted is unreachable: the owner
///      must call `permitVenue` for each, and `config.production.json` must name them with the
///      right `kind` — `share-priced` for both of these, since each issues shares whose price
///      drifts upward. Until both happen the account still reaches Aave and nothing else, and the
///      submission must not claim otherwise.
///
///      Run:
///        forge script script/DeployVenues.s.sol:DeployVenues \
///          --rpc-url $ARBITRUM_RPC_URL --broadcast --verify --private-key "$KEY"
///
///      Environment:
///        COMET_ADDRESS   Compound v3 market. Defaults to cUSDCv3 on Arbitrum One.
///        MORPHO_VAULT    ERC-4626 vault. Defaults to bbqUSDC, the Steakhouse USDC vault, chosen
///                        for depth rather than headline yield: a venue that cannot pay out is a
///                        venue the cover search skips. Set it deliberately if that is not wanted.
contract DeployVenues is Script {
    uint256 constant ARBITRUM_ONE = 42161;

    /// @dev Native USDC on Arbitrum One — the same token the Aave venue and every fork test use.
    address public constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;

    /// @dev `cUSDCv3`. Read from the chain rather than taken from documentation: `symbol()`
    ///      answers "cUSDCv3", `baseToken()` answers the USDC above, `decimals()` answers 6.
    address public constant COMET = 0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf;

    /// @dev `bbqUSDC`, Steakhouse. `MORPHO()` answers Morpho Blue at `0x6c247b1F…`, `asset()`
    ///      answers the USDC above, and `decimals()` answers **18** against the asset's six —
    ///      which is the mismatch `MorphoVenue` exists to absorb.
    address public constant MORPHO_VAULT = 0x5c0C306Aaa9F877de636f4d5822cA9F2E81563BA;

    error WrongChain(uint256 actual);
    error NoCode(address target);
    error AssetMismatch(address target, address answered, address expected);
    error ReceiptIsNotItself(address venue, address answered);
    error RateNotSane(address venue, uint256 ray);

    function run() external returns (CompoundVenue compound, MorphoVenue morpho) {
        if (block.chainid != ARBITRUM_ONE) revert WrongChain(block.chainid);

        address comet = vm.envOr("COMET_ADDRESS", COMET);
        address vault = vm.envOr("MORPHO_VAULT", MORPHO_VAULT);

        if (comet.code.length == 0) revert NoCode(comet);
        if (vault.code.length == 0) revert NoCode(vault);

        address cometAsset = IComet(comet).baseToken();
        address vaultAsset = IERC4626Vault(vault).asset();
        if (cometAsset != USDC) revert AssetMismatch(comet, cometAsset, USDC);
        if (vaultAsset != USDC) revert AssetMismatch(vault, vaultAsset, USDC);

        vm.startBroadcast();
        compound = new CompoundVenue(IComet(comet));
        morpho = new MorphoVenue(IERC4626Vault(vault));
        vm.stopBroadcast();

        _check(address(compound), compound.UNDERLYING_ASSET_ADDRESS(), compound.getReserveAToken(USDC));
        _check(address(morpho), morpho.UNDERLYING_ASSET_ADDRESS(), morpho.getReserveAToken(USDC));

        // Compound answers a rate immediately; Morpho's is trailing and reads zero until a window
        // has passed, which is correct rather than broken and is why only one is checked here.
        uint256 ray = compound.getReserveData(USDC).currentLiquidityRate;
        if (ray < 1e23 || ray > 5e26) revert RateNotSane(address(compound), ray);

        console.log("compound venue", address(compound));
        console.log("morpho venue  ", address(morpho));
        console.log("comet         ", comet);
        console.log("morpho vault  ", vault);
        console.log("asset         ", USDC);
        console.log("compound bps  ", ray / 1e23);
        console.log("chain         ", block.chainid);
    }

    /// @dev Both halves of the trick this design rests on: the venue answers Aave's spelling, and
    ///      names itself as its own receipt. A deployment where either is false would pass every
    ///      other check and be refused by `_requireReceiptFor` on the first cover.
    function _check(address venue, address underlying, address receipt) internal pure {
        if (underlying != USDC) revert AssetMismatch(venue, underlying, USDC);
        if (receipt != venue) revert ReceiptIsNotItself(venue, receipt);
    }
}
