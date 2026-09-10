// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {CompoundVenue} from "../src/CompoundVenue.sol";
import {IComet} from "../src/IComet.sol";

/// @notice One `CompoundVenue` over one Comet market, for the assets the first pair did not cover.
///
/// @dev **Why this is not a flag on `DeployVenues`.** That script deploys the Compound and Morpho
///      venues together over USDC, and it has already run — its addresses are in `deployments.md`,
///      permitted on the account and named in `config.production.json`. Widening it to take an
///      asset would mean the next person reading it has to work out which of its two venues a given
///      run produced. This one deploys a single venue and says which market it came from.
///
///      **The check that matters is still that the asset is declared and then confirmed.** A venue
///      over the wrong market deploys cleanly, answers every read, and makes the enclave compare
///      positions in two different tokens as though they were one. Arbitrum has that trap in the
///      family this script is aimed at: `cUSDCv3` is native USDC and `cUSDCev3` is bridged USDC.e.
///      So `ASSET` is passed in and the chain is asked to agree, rather than being read off the
///      market — reading it off the market would make the check unable to fail.
///
///      **Deploying is not the last step.** A venue nobody has permitted is unreachable: the owner
///      must call `permitVenue`, and `config.production.json` must name it with `kind`
///      `share-priced`. Until both happen the account reaches only what it already reached, and the
///      submission must not claim otherwise.
///
///      Run:
///        forge script script/DeployCompoundVenue.s.sol:DeployCompoundVenue \
///          --rpc-url $ARBITRUM_RPC_URL --broadcast --verify --private-key "$KEY"
///
///      Environment:
///        COMET_ADDRESS   Compound v3 market. Defaults to `cWETHv3` on Arbitrum One.
///        ASSET           The token that market is denominated in. Defaults to WETH.
contract DeployCompoundVenue is Script {
    uint256 constant ARBITRUM_ONE = 42161;

    /// @dev `cWETHv3`. Read from the chain rather than taken from documentation: `symbol()` answers
    ///      "cWETHv3", `baseToken()` answers the WETH below, and `decimals()` answers 18.
    address public constant COMET = 0x6f7D514bbD4aFf3BcD1140B7344b32f063dEe486;

    /// @dev WETH on Arbitrum One — the same token every fork test and the maker position use.
    address public constant ASSET = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;

    error WrongChain(uint256 actual);
    error NoCode(address target);
    error AssetMismatch(address target, address answered, address expected);
    error ReceiptIsNotItself(address venue, address answered);
    error RateNotSane(address venue, uint256 ray);

    function run() external returns (CompoundVenue venue) {
        if (block.chainid != ARBITRUM_ONE) revert WrongChain(block.chainid);

        address comet = vm.envOr("COMET_ADDRESS", COMET);
        address asset = vm.envOr("ASSET", ASSET);

        if (comet.code.length == 0) revert NoCode(comet);
        if (asset.code.length == 0) revert NoCode(asset);

        address base = IComet(comet).baseToken();
        if (base != asset) revert AssetMismatch(comet, base, asset);

        vm.startBroadcast();
        venue = new CompoundVenue(IComet(comet));
        vm.stopBroadcast();

        // Both halves of the trick this design rests on: the venue answers Aave's spelling, and it
        // names itself as its own receipt. A deployment where either is false passes every other
        // check here and is refused by `_requireReceiptFor` on the first cover.
        address underlying = venue.UNDERLYING_ASSET_ADDRESS();
        if (underlying != asset) revert AssetMismatch(address(venue), underlying, asset);
        address receipt = venue.getReserveAToken(asset);
        if (receipt != address(venue)) revert ReceiptIsNotItself(address(venue), receipt);

        // A live market pays something and pays less than fifty percent. Both ends matter: the
        // per-second-to-annual conversion is two multiplications, and dropping either lands far
        // outside this window rather than slightly off.
        uint256 ray = venue.getReserveData(asset).currentLiquidityRate;
        if (ray < 1e23 || ray > 5e26) revert RateNotSane(address(venue), ray);

        console.log("compound venue", address(venue));
        console.log("comet         ", comet);
        console.log("asset         ", asset);
        console.log("symbol        ", venue.symbol());
        console.log("decimals      ", venue.decimals());
        console.log("bps           ", ray / 1e23);
        console.log("chain         ", block.chainid);
    }
}
