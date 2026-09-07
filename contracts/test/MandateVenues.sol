// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ILendingVenue} from "../src/ILendingVenue.sol";

/// @notice A lending market's receipt token, modelled on an Aave aToken.
///
/// @dev Two properties matter to the app and are reproduced faithfully. It names the asset it is
///      a receipt for, which is the only question `_requireReceiptFor` asks. And it names the
///      pool that issued it, which is the question nobody asks — a second market's receipt for
///      the same asset answers `UNDERLYING_ASSET_ADDRESS()` identically.
///
///      Transfers are refused while the sender has debt. Aave does this in `finalizeTransfer`,
///      and it is why a mandate can only be unwound for a maker who has not borrowed: without
///      it, the refusal a test expects would come from our own check even when the market would
///      have allowed the move, and the test would prove nothing.
contract MockReceipt is ERC20 {
    error SenderHasDebt(address from);

    address public immutable UNDERLYING;
    address public immutable POOL;

    constructor(string memory name_, string memory symbol_, address underlying_, address pool_)
        ERC20(name_, symbol_)
    {
        UNDERLYING = underlying_;
        POOL = pool_;
    }

    function UNDERLYING_ASSET_ADDRESS() external view returns (address) {
        return UNDERLYING;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == POOL, "only pool");
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        require(msg.sender == POOL, "only pool");
        _burn(from, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            require(MockLendingPool(POOL).debtOf(from) == 0, SenderHasDebt(from));
        }
        super._update(from, to, value);
    }
}

/// @notice A lending market, modelled on an Aave v3 Pool.
///
/// @dev The load-bearing detail: `withdraw` burns *this pool's own* receipt from `msg.sender`.
///      It never looks at whatever receipt the caller pulled in beforehand. That is Aave's
///      behaviour, and it is what makes the pool-to-receipt pairing something the app has to
///      establish for itself rather than something a market will check on its behalf.
contract MockLendingPool is ILendingVenue {
    mapping(address asset => MockReceipt) public receiptFor;
    mapping(address user => uint256) public debtOf;

    uint256 public withdrawCalls;

    /// @dev Lists an asset and issues its receipt token. Called once per asset in a test's setup.
    function list(address asset, string memory symbol) external returns (MockReceipt receipt) {
        receipt = new MockReceipt(symbol, symbol, asset, address(this));
        receiptFor[asset] = receipt;
    }

    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external {
        SafeERC20.safeTransferFrom(IERC20(asset), msg.sender, address(this), amount);
        receiptFor[asset].mint(onBehalfOf, amount);
    }

    function setDebt(address user, uint256 debt) external {
        debtOf[user] = debt;
    }

    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        withdrawCalls++;
        receiptFor[asset].burn(msg.sender, amount);
        SafeERC20.safeTransfer(IERC20(asset), to, amount);
        return amount;
    }

    function getReserveAToken(address asset) external view returns (address) {
        return address(receiptFor[asset]);
    }

    function getVirtualUnderlyingBalance(address asset) external view returns (uint128) {
        return uint128(IERC20(asset).balanceOf(address(this)));
    }

    function getUserAccountData(address user)
        external
        view
        returns (uint256, uint256, uint256, uint256, uint256, uint256)
    {
        return (0, debtOf[user], 0, 0, 0, type(uint256).max);
    }
}
