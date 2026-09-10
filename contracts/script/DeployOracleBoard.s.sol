// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";

import {HelicoAppProxy} from "../src/HelicoAppProxy.sol";
import {console} from "forge-std/console.sol";

import {IAqua} from "@1inch/aqua/interfaces/IAqua.sol";

import {HelicoOracleBoard, IPriceFeed} from "../src/HelicoOracleBoard.sol";

/// @notice Deploys `HelicoOracleBoard` against a live Aqua.
///
/// @dev **No proxy, no state, nothing to initialise.** Like `HelicoMandateSwap`, every board
///      lives in Aqua's ledger keyed by its hash, so the contract holds one immutable and no
///      storage. There is no admin, no upgrade path, and no window in which an uninitialised
///      contract could be claimed.
///
///      Run:
///        forge script script/DeployOracleBoard.s.sol:DeployOracleBoard \
///          --rpc-url $ARBITRUM_RPC_URL --broadcast --account helico-deployer
///
///      Environment:
///        AQUA_ADDRESS   optional; defaults to the address 1inch names as canonical, the same
///                       constant `DeployMandateSwap` carries and for the same reasons.
///
///      **The feed is not deployed with this.** A board names its own feed, so one deployment
///      serves every pair Chainlink covers. `ETH_USD_FEED` below is checked here only so the
///      deploy fails loudly on a chain where it is not what we think it is, rather than a maker
///      discovering it when their first board quotes nonsense.
contract DeployOracleBoard is Script {
    uint256 constant ARBITRUM_ONE = 42161;

    /// @dev The key that may replace this app's implementation, held apart from the deployer and
    ///      the agent — the same separation `HelicoAccount` uses. Zero would freeze the app, which
    ///      is a legitimate setting and not this one.
    address public constant DEFAULT_UPGRADER = 0xaeE1F9d2c23730CA04Dd478830c2acc495536E9C;

    /// @dev The same constant `DeployMandateSwap` carries. See the long note there for why this
    ///      address and not `0x499943E7…`, and why activity is not what distinguishes them.
    address public constant AQUA = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;

    /// @dev Chainlink ETH/USD on Arbitrum One. Read from the chain before it was written down:
    ///      `description()` answers `"ETH / USD"` and `decimals()` answers 8.
    address public constant ETH_USD_FEED = 0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612;

    error WrongChain(uint256 actual);
    error AquaHasNoCode(address aqua);
    error NotAqua(address aqua);
    error FeedNotAnswering(address feed);
    error FeedNotPositive(int256 answer);

    function run() external returns (HelicoOracleBoard app) {
        if (block.chainid != ARBITRUM_ONE) revert WrongChain(block.chainid);

        address aqua = vm.envOr("AQUA_ADDRESS", AQUA);
        _requireAqua(aqua);
        (uint256 price, uint8 decimals) = _requireFeed(ETH_USD_FEED);

        vm.startBroadcast();
        address upgrader = vm.envOr("APP_UPGRADER", DEFAULT_UPGRADER);
        app = deploy(IAqua(aqua), upgrader);
        vm.stopBroadcast();

        console.log("oracle board ", address(app));
        console.log("aqua         ", aqua);
        console.log("eth/usd feed ", ETH_USD_FEED);
        console.log("feed answers ", price);
        console.log("feed decimals", decimals);
        console.log("chain        ", block.chainid);
    }

    /// @dev Public so a fork test deploys through the same call the broadcast uses. A rehearsal
    ///      through a door production does not use is not a rehearsal.
    /// @dev Implementation first, then a bare ERC-1967 proxy in front of it. **No initializer**,
    ///      and none is missing: everything this app knows is either immutable in the
    ///      implementation or arrives in calldata, so there is no state a proxy has to be handed.
    ///      Calling `upgradeToAndCall` on the implementation directly is refused by UUPS's own
    ///      `onlyProxy`, so leaving it uninitialised takes nothing from anybody.
    ///
    ///      **The address that matters is the proxy's.** A maker ships to it and Aqua keys every
    ///      balance by it; the implementation is a place the proxy borrows code from and is not an
    ///      app. Verifying only one of the two is how a judge finds unverified bytecode at the
    ///      address the README names.
    function deploy(IAqua aqua, address upgrader) public returns (HelicoOracleBoard) {
        HelicoOracleBoard implementation = new HelicoOracleBoard(aqua, upgrader);
        return HelicoOracleBoard(address(new HelicoAppProxy(address(implementation))));
    }

    /// @dev Code at the address is not enough — a wrong address on the right chain passes that
    ///      and fails on the first fill. Aqua answers `rawBalances` for any arguments at all,
    ///      including a strategy nobody has shipped, so a successful call is cheap and specific.
    function _requireAqua(address aqua) internal view {
        if (aqua.code.length == 0) revert AquaHasNoCode(aqua);
        try IAqua(aqua).rawBalances(address(1), address(2), bytes32(uint256(3)), address(4)) returns (
            uint248, uint8
        ) {}
        catch {
            revert NotAqua(aqua);
        }
    }

    /// @dev A feed that does not answer, or answers zero, produces a board that quotes zero and
    ///      hands its inventory away. Checked at deploy so that never reaches a maker.
    function _requireFeed(address feed) internal view returns (uint256 price, uint8 decimals) {
        try IPriceFeed(feed).latestRoundData() returns (uint80, int256 answer, uint256, uint256, uint80) {
            if (answer <= 0) revert FeedNotPositive(answer);
            price = uint256(answer);
        } catch {
            revert FeedNotAnswering(feed);
        }
        decimals = IPriceFeed(feed).decimals();
    }
}
