// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @title The proxy an Aqua app sits behind, and the one check it deliberately turns off.
///
/// @dev OpenZeppelin's `ERC1967Proxy` refuses construction with empty `_data` — a proxy is normally
///      expected to be initialised in the same transaction, because the gap between deploying one
///      and initialising it is where somebody else calls `initialize` and takes ownership.
///
///      **These apps have nothing to initialise, and that is a fact about them rather than an
///      oversight.** Everything `HelicoMandateSwap` and `HelicoOracleBoard` know is either
///      immutable in the implementation — `AQUA`, `UPGRADER` — or arrives in the calldata of the
///      call being served. Neither declares an `initialize`, neither has an owner in storage, and
///      the only storage either has is `_reentrancyLocks`, which is a transient lock keyed by maker
///      and strategy. There is no function to race and no state to seize.
///
///      Writing an empty `initialize()` purely to satisfy the check would pass it while teaching
///      the next reader that there is state here to protect. Turning the check off with the reason
///      written down is the more honest of the two, and it is why this file exists rather than a
///      one-line initializer somewhere in the apps.
///
///      What the check protects against and this does not: an implementation that *does* have an
///      initializer. If either app ever gains one, this proxy must stop being used for it.
contract HelicoAppProxy is ERC1967Proxy {
    constructor(address implementation) ERC1967Proxy(implementation, "") {}

    function _unsafeAllowUninitialized() internal pure override returns (bool) {
        return true;
    }
}
