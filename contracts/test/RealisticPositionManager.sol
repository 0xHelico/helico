// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PoolKey} from "../src/Mandate.sol";
import {IPositionManager} from "../src/IPositionManager.sol";
import {IPoolManager, IUnlockCallback} from "../src/IPoolManager.sol";

/// @notice A minimal ERC-20 for settlement in the mock. Balances only; no allowances, because
///         nothing in these tests pulls funds from a third party.
contract MockERC20 {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }
}

/// @notice A stand-in for Uniswap v4's PositionManager that **behaves** like one.
///
/// @dev The mock it replaces only recorded its arguments, so it could never refuse anything —
///      and a suite written against it passed while the contract under test was drainable. This
///      one decodes `unlockData` into `(actions, params)` and runs the same loop v4 runs:
///
///      - `DECREASE_LIQUIDITY` and `BURN_POSITION` require approved-or-owner, exactly as
///        v4-periphery's `onlyIfApproved(msgSender(), tokenId)` does.
///      - `MINT_POSITION` sends the new NFT to the `owner` named in the payload, and mints a
///        fresh `tokenId` from the same `nextTokenId` counter v4 uses.
///      - `TAKE_PAIR` pays out to the recipient named in the payload.
///      - Deltas are tracked across the batch, so a mint that costs more than the batch has
///        credited reverts instead of quietly succeeding.
///
///      What it deliberately does NOT model is pricing: the cost of L is linear here, not the
///      sqrt-price curve. These tests are about **who may act and where value lands**, and a
///      fake price curve would only make them look more authoritative than they are.
///
///      Opcodes verified against v4-periphery `src/libraries/Actions.sol` @ main:
///      DECREASE_LIQUIDITY 0x01 · MINT_POSITION 0x02 · BURN_POSITION 0x03 · TAKE_PAIR 0x11.
contract RealisticPositionManager is IPositionManager {
    struct Position {
        PoolKey key;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 fees0;
        uint256 fees1;
    }

    mapping(uint256 => address) internal _owners;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    mapping(uint256 => Position) internal _positions;

    uint256 public nextTokenId = 1;

    MockERC20 public immutable token0;
    MockERC20 public immutable token1;

    /// @dev Amount of each token one unit of liquidity is worth. Uniform across ranges on
    ///      purpose — see the note above on what this mock does not model.
    uint256 public costPerLiquidity = 1;

    /// @dev Tokens backing live positions. Anything above this is what a caller transferred in
    ///      for the batch in progress, which is what `SETTLE` may spend and `SWEEP` returns.
    uint256 public reserved0;
    uint256 public reserved1;

    uint256 internal _owed0;
    uint256 internal _owed1;

    error NotApproved();
    error DeltaNotPositive();
    error MaximumAmountExceeded();
    error NotEnoughLiquidity();
    error UnsupportedAction(uint8 action);

    constructor(MockERC20 a, MockERC20 b) {
        token0 = a;
        token1 = b;
    }

    // --- ERC-721 surface the vault uses --------------------------------------------------

    function ownerOf(uint256 tokenId) public view returns (address) {
        address owner = _owners[tokenId];
        require(owner != address(0), "ERC721: nonexistent token");
        return owner;
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
    }

    function transferFrom(address from, address to, uint256 tokenId) external {
        require(_owners[tokenId] == from, "wrong from");
        require(msg.sender == from || isApprovedForAll[from][msg.sender], "not approved");
        _owners[tokenId] = to;
    }

    // --- v4 view surface -----------------------------------------------------------------

    function getPositionLiquidity(uint256 tokenId) external view returns (uint128) {
        return _positions[tokenId].liquidity;
    }

    /// @dev `PositionInfo` packing verified against v4-periphery `PositionInfoLibrary`:
    ///      200 bits poolId | 24 bits tickUpper | 24 bits tickLower | 8 bits hasSubscriber.
    function getPoolAndPositionInfo(uint256 tokenId) external view returns (PoolKey memory, uint256) {
        Position storage p = _positions[tokenId];
        uint256 info = (uint256(uint24(p.tickUpper)) << 32) | (uint256(uint24(p.tickLower)) << 8);
        return (p.key, info);
    }

    // --- test helpers --------------------------------------------------------------------

    function setCostPerLiquidity(uint256 value) external {
        costPerLiquidity = value;
    }

    function setFees(uint256 tokenId, uint256 fees0, uint256 fees1) external {
        _positions[tokenId].fees0 = fees0;
        _positions[tokenId].fees1 = fees1;
        token0.mint(address(this), fees0);
        token1.mint(address(this), fees1);
    }

    function mintTo(address to, PoolKey memory key, int24 tickLower, int24 tickUpper, uint128 liquidity)
        external
        returns (uint256 tokenId)
    {
        tokenId = nextTokenId++;
        _owners[tokenId] = to;
        _positions[tokenId] = Position({
            key: key, tickLower: tickLower, tickUpper: tickUpper, liquidity: liquidity, fees0: 0, fees1: 0
        });
        uint256 backing = uint256(liquidity) * costPerLiquidity;
        token0.mint(address(this), backing);
        token1.mint(address(this), backing);
        reserved0 += backing;
        reserved1 += backing;
    }

    // --- the action loop -----------------------------------------------------------------

    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable {
        require(block.timestamp <= deadline, "deadline passed");
        (bytes memory actions, bytes[] memory params) = abi.decode(unlockData, (bytes, bytes[]));
        _run(actions, params);
    }

    function _run(bytes memory actions, bytes[] memory params) internal {
        uint256 credit0;
        uint256 credit1;

        for (uint256 i = 0; i < actions.length; i++) {
            uint8 action = uint8(actions[i]);

            if (action == 0x01) {
                (uint256 tokenId, uint256 liquidity, uint128 amount0Min, uint128 amount1Min,) =
                    abi.decode(params[i], (uint256, uint256, uint128, uint128, bytes));
                if (!_approvedOrOwner(msg.sender, tokenId)) revert NotApproved();

                Position storage p = _positions[tokenId];
                if (liquidity > p.liquidity) revert NotEnoughLiquidity();
                uint256 out = liquidity * costPerLiquidity;
                if (out < amount0Min || out < amount1Min) revert DeltaNotPositive();

                p.liquidity -= uint128(liquidity);
                reserved0 -= out;
                reserved1 -= out;
                credit0 += out;
                credit1 += out;
            } else if (action == 0x02) {
                (
                    PoolKey memory key,
                    int24 tickLower,
                    int24 tickUpper,
                    uint256 liquidity,
                    uint128 amount0Max,
                    uint128 amount1Max,
                    address owner,
                ) = abi.decode(params[i], (PoolKey, int24, int24, uint256, uint128, uint128, address, bytes));

                uint256 cost = liquidity * costPerLiquidity;
                if (cost > amount0Max || cost > amount1Max) revert MaximumAmountExceeded();
                // v4 nets deltas across the batch. Credit from an earlier action in the same
                // batch covers the mint first; whatever is left becomes a debt for `SETTLE`.
                // Credit from an earlier action in the same batch pays first, and that part is
                // backed immediately. The remainder is a debt, and only becomes backing once
                // `SETTLE` collects it.
                uint256 fromCredit0 = cost < credit0 ? cost : credit0;
                credit0 -= fromCredit0;
                reserved0 += fromCredit0;
                _owed0 += cost - fromCredit0;

                uint256 fromCredit1 = cost < credit1 ? cost : credit1;
                credit1 -= fromCredit1;
                reserved1 += fromCredit1;
                _owed1 += cost - fromCredit1;

                uint256 newId = nextTokenId++;
                _owners[newId] = owner;
                _positions[newId] = Position({
                    key: key,
                    tickLower: tickLower,
                    tickUpper: tickUpper,
                    liquidity: uint128(liquidity),
                    fees0: 0,
                    fees1: 0
                });
            } else if (action == 0x03) {
                (uint256 tokenId,,,) = abi.decode(params[i], (uint256, uint128, uint128, bytes));
                if (!_approvedOrOwner(msg.sender, tokenId)) revert NotApproved();

                Position storage p = _positions[tokenId];
                // v4's `_burn` decreases any remaining liquidity to zero first.
                uint256 out = uint256(p.liquidity) * costPerLiquidity;
                credit0 += out + p.fees0;
                credit1 += out + p.fees1;
                p.liquidity = 0;
                reserved0 -= out;
                reserved1 -= out;
                delete _owners[tokenId];
                delete _positions[tokenId];
            } else if (action == 0x11) {
                (,, address recipient) = abi.decode(params[i], (address, address, address));
                if (credit0 > 0) token0.transfer(recipient, credit0);
                if (credit1 > 0) token1.transfer(recipient, credit1);
                credit0 = 0;
                credit1 = 0;
            } else if (action == 0x0b) {
                // SETTLE(currency, amount, payerIsUser). v4 pays from its own balance when
                // `payerIsUser` is false, which is how the vault funds a mint without granting
                // anyone a Permit2 allowance.
                (address currency,, bool payerIsUser) = abi.decode(params[i], (address, uint256, bool));
                require(!payerIsUser, "mock only models payerIsUser=false");
                if (currency == address(token0)) {
                    require(_free0() >= _owed0, "DeltaNotSettled");
                    reserved0 += _owed0;
                    _owed0 = 0;
                } else {
                    require(_free1() >= _owed1, "DeltaNotSettled");
                    reserved1 += _owed1;
                    _owed1 = 0;
                }
            } else if (action == 0x14) {
                // SWEEP(currency, to) returns whatever the batch did not consume.
                (address currency, address to) = abi.decode(params[i], (address, address));
                uint256 free = currency == address(token0) ? _free0() : _free1();
                if (free > 0) {
                    if (currency == address(token0)) token0.transfer(to, free);
                    else token1.transfer(to, free);
                }
            } else {
                revert UnsupportedAction(action);
            }
        }
    }

    /// @dev The same action loop, for a caller that already holds the pool lock. This is the
    ///      entry point the vault uses now that it takes the lock itself.
    function modifyLiquiditiesWithoutUnlock(bytes calldata actions, bytes[] calldata params)
        external
        payable
    {
        _run(actions, params);
    }

    function _free0() internal view returns (uint256) {
        uint256 balance = token0.balanceOf(address(this));
        return balance > reserved0 ? balance - reserved0 : 0;
    }

    function _free1() internal view returns (uint256) {
        uint256 balance = token1.balanceOf(address(this));
        return balance > reserved1 ? balance - reserved1 : 0;
    }

    function _approvedOrOwner(address spender, uint256 tokenId) internal view returns (bool) {
        address owner = _owners[tokenId];
        return spender == owner || isApprovedForAll[owner][spender];
    }
}

/// @notice Stands in for v4's `StateView`. Only `getSlot0` is needed: the vault reads the
///         current tick to check a proposed range actually brackets the market price.
contract MockStateView {
    mapping(bytes32 => int24) public tickOf;

    function setTick(bytes32 poolId, int24 tick) external {
        tickOf[poolId] = tick;
    }

    function getSlot0(bytes32 poolId) external view returns (uint160, int24, uint24, uint24) {
        return (0, tickOf[poolId], 0, 0);
    }
}

/// @notice Stands in for v4's singleton PoolManager, for the parts the vault uses outside a swap.
///
/// @dev `unlock` is modelled because the vault now takes the lock itself. `swap` is not, and
///      deliberately reverts: modelling a price curve here would let a test assert something
///      about the swap that only holds against this mock's arithmetic, which is how a drainable
///      vault shipped with twenty green tests once already. The swap is proven on a fork.
contract MockPoolManager is IPoolManager {
    error SwapIsForkTestedOnly();

    bool public unlocked;

    function unlock(bytes calldata data) external returns (bytes memory) {
        require(!unlocked, "AlreadyUnlocked");
        unlocked = true;
        bytes memory result = IUnlockCallback(msg.sender).unlockCallback(data);
        unlocked = false;
        return result;
    }

    function swap(PoolKey memory, SwapParams memory, bytes calldata) external pure returns (int256) {
        revert SwapIsForkTestedOnly();
    }

    function sync(address) external pure {
        revert SwapIsForkTestedOnly();
    }

    function settle() external payable returns (uint256) {
        revert SwapIsForkTestedOnly();
    }

    function take(address, address, uint256) external pure {
        revert SwapIsForkTestedOnly();
    }
}
