// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";

import {HelicoAppProxy} from "../src/HelicoAppProxy.sol";
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

    /// @dev The key that may replace this app's implementation, held apart from the deployer and
    ///      the agent — the same separation `HelicoAccount` uses. Zero would freeze the app, which
    ///      is a legitimate setting and not this one.
    address public constant DEFAULT_UPGRADER = 0xaeE1F9d2c23730CA04Dd478830c2acc495536E9C;

    /// @dev The address 1inch names as canonical, confirmed by them directly in `#partner-1inch`
    ///      and published in their README: *"Only interact with these two contracts. Anything
    ///      else is not Aqua."*
    ///
    ///      This was `0x499943E7…` until 8 September, taken from the README inside the `v1.0.0`
    ///      tag we vendor. **That was our mistake, not a stale document.** The tag's commit is
    ///      from 17 March and a tag is a snapshot, which is what a tag is for; `1inch/aqua` is
    ///      actively maintained — last pushed 21 August — and its `main` README names this
    ///      address correctly. We pinned a snapshot and then read its README as though it were
    ///      current documentation. Pin the code, but read the addresses from `main` or the SDK.
    ///      Both addresses hold code and both answer `rawBalances` for an unknown strategy, so
    ///      behaviour cannot tell them apart — which is why the check below is necessary and
    ///      also why it was not sufficient.
    ///
    ///      What separates them: their bytecode differs (11,241 vs 12,505), `main`'s README names
    ///      this one, the vendored Aqua SDK exports it, and the deployed `AquaSwapVMRouter` carries it
    ///      in its bytecode with no reference to the other.
    ///
    ///      Activity separates nothing, and the first version of this note said the opposite —
    ///      that the stale address had 1,289 events while this one had none. The 1,289 is right;
    ///      the rest was a measurement error. Measured 8 September, both are live: the stale one
    ///      has been silent since block 451,737,844, and this one was still emitting hours ago.
    ///      So a count of events picks the wrong contract, and a count of *recent* events picks
    ///      the right one for a reason that is luck rather than evidence. The partner's own word
    ///      is the deciding one, and a vendor constant is the only thing a maker cannot forge.
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
        address upgrader = vm.envOr("APP_UPGRADER", DEFAULT_UPGRADER);
        app = deploy(IAqua(aqua), upgrader);
        vm.stopBroadcast();

        console.log("mandate swap ", address(app));
        console.log("aqua         ", aqua);
        console.log("chain        ", block.chainid);
    }

    /// @dev Public so the fork test deploys through the same call the broadcast uses. A
    ///      rehearsal through a door production does not use is not a rehearsal.
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
    function deploy(IAqua aqua, address upgrader) public returns (HelicoMandateSwap) {
        HelicoMandateSwap implementation = new HelicoMandateSwap(aqua, upgrader);
        return HelicoMandateSwap(address(new HelicoAppProxy(address(implementation))));
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
