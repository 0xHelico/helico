# CRE: deliver the verdict to the vault through the forwarder

Issue: #37 (workflow side). The contract side, `onReport` on `HelicoVault`, is a separate piece
of work by the collaborator.

## Problem

The enclave computes a verdict and it goes nowhere. Nothing on-chain consumes it, so the
confidential workflow is adjacent to the product rather than part of it. The vault's
`recenter` takes `RecenterParams` (`owner`, two ticks, `liquidityToMint`, four amount bounds,
`deadline`); the report today carries only the ticks and the mandate hash.

## Constraints, verified

- A `handlerInTee` workflow cannot be deployed without the Confidential Workflows private
  beta, and the CRE account here has no deploy access. The on-chain run is therefore
  `cre workflow simulate --broadcast`: the CLI signs with `CRE_ETH_PRIVATE_KEY` and delivers
  through the `MockKeystoneForwarder`, which performs no DON signature check and passes no
  metadata. On Robinhood Chain Testnet: mock `0x0b93082D9b3C7C97fAcd250082899BAcf3af3885`,
  production `0x8E6E6A1f2B2D4dF503bfd67951CF28F27BF3AF19`. Robinhood mainnet has neither.
- The workflow's `EVMClient.writeReport(runtime, { receiver, report, gasConfig })` takes the
  `ReportResponse` from `runtime.report(...)` as is; the receiver decodes the bytes it was
  given as `encodedPayload`.
- The e2e position (#2544) was burned; the demo needs a freshly minted one.

## Approach

Report shape, proposed on #37: `abi.encode(bool act, bytes32 mandateHash, RecenterParams p)`.
The vault decodes its own struct; nothing is derived on-chain.

The enclave, per run:

1. Reads from the chain, through `eth_call` inside the enclave: `vault.positionOf(owner)`,
   `vault.lastActionAt(owner)`, `positionManager.getPositionLiquidity(tokenId)`,
   `positionManager.getPoolAndPositionInfo(tokenId)` (ticks unpacked as the vault does),
   `stateView.getSlot0(poolId)`. The vault is the source of truth for the cooldown and the
   current range; `config.position` goes away.
2. Recomputes the mandate hash from the secrets and refuses on mismatch, as before.
3. `decideRecentre` as before.
4. On `act`, sizes the mint: amounts the burn will return from `L` at the current
   `sqrtPriceX96` over the old range (v3 `SqrtPriceMath`, rounding down), the liquidity those
   amounts buy over the new range (`maxLiquidityForAmounts`), scaled down by
   `config.slippageBps`; `amount0Min`/`amount1Min` = withdrawn amounts scaled down by the same;
   `amount0Max`/`amount1Max` = the withdrawn amounts, since the mint is funded only by the burn;
   `deadline = now + config.deadlineSeconds`. Native `BigInt`, no JSBI in the WASM bundle;
   cross-checked against `@uniswap/v3-sdk` (dev dependency) over a grid in tests.
5. `runtime.report(...)` with the encoded tuple, then `EVMClient.writeReport` to
   `config.vault` on `config.chainSelectorName`. A hold is not written.

Config becomes `{ schedule, rpcUrl, chainSelectorName, vault, positionManager, stateView,
owner, poolId, mandateHash, gasLimit, slippageBps, deadlineSeconds }`; the tick spacing comes
from the position's pool key.

## How to verify

1. `bun run --filter @helico/plugin-cre typecheck` and `test`: the math grid against the
   Uniswap SDK, the read path against a fake JSON-RPC answering by selector, and the fake
   `TeeRuntime` asserting the report tuple and the `writeReport` call.
2. `cre workflow simulate` (dry run) against Robinhood Chain Testnet with a live position:
   the log shows the tuple and a zero transaction hash.
3. Once the vault with `onReport` is deployed there: `--broadcast`, a real hash, and the
   `Recentred` event on the explorer. Recorded for #21.

## Prompts

The user's instruction was "cek lagi" (check again) after "lanjutin aja sesuai kemauan
temenku ya" (keep going according to what my friend wants). The collaborator's request is
issue #37. The report shape is my proposal on that issue; the rest follows the CRE docs on
on-chain writes and the forwarder directory.

## Revisions — same day, after review and #42

- **Zero mint defect.** With `minRetainedBps = 0` the floor check is `0 < 0` and a zero-liquidity
  mint went through to `act = true`. Fixed with an unconditional hold on `liquidityToMint === 0`,
  regardless of the floor; the vault adds the same `NothingToMint` on its side.
- **The swap is in the report.** #42 chose option 1: the vault swaps inside its own unlock.
  `RecenterParams` gains `zeroForOne`, `amountIn`, `minAmountOut` after `amount1Max` and before
  `deadline`. `sizeRecentre` estimates the swap at the pool's active liquidity with the pool's
  LP fee (`getNextSqrtPriceFromInput`, cross-checked against the SDK), bounds the input so the
  price stays inside the new range (where the vault's `sqrtPriceLimitX96` would stop it), and
  finds the input where the two sides fund the same liquidity by binary search.
- **Fee ceiling.** `maxPoolFeePips` is enclave policy: launch pools on Robinhood carry 6 to 20%
  LP fees, and a re-centre through one costs more than it recovers.
- **Chain.** The user chose Robinhood mainnet only; `writeReport` has no forwarder there, so the
  delivery leg is the one #41 replaces with signing. Everything else in this plan stands.
- **Config hex values are lowercased** on parse so a checksummed value compares equal to keccak
  output; the report tuple is pinned to a `cast abi-encode` vector; RPC faults throw.

## Revision — 2026-09-06, the chain moved to Arbitrum One (#58)

The project moved from Robinhood Chain to Arbitrum One because Arbitrum has both Uniswap v4 (all
addresses from the SDK) and a CRE `KeystoneForwarder`, at a twentieth of the gas. For this plan
that means the forwarder path is back on the critical path: `chainSelectorName:
'ethereum-mainnet-arbitrum-1'`, production forwarder `0xF8344CFd5c43616a4366C34E3EEE75af79a74482`,
and `cre workflow simulate --broadcast` through the `MockKeystoneForwarder`
`0xd770499057619c9a76205fd4168161cf94abc532`. The signature path stays as the chain-independent
design and the reason `AGENT_ROLE` can be a key that exists only inside an enclave. Nothing in
the package changed for the move; this revision records the config and the dependency on the
vault's `onReport` (#37). Tracked in #61.

## Rehearsal — 2026-09-06, end to end on a fork of Arbitrum One (#71)

The first time a report left the workflow, went through a forwarder, and moved a position in a
vault that executed it. Not a live network: a local fork of Arbitrum One, which keeps the real
`PoolManager`, `StateView`, `PositionManager`, the real ETH/ARB 0.05% pool with its real depth,
and the `MockKeystoneForwarder` the CRE CLI broadcasts through, all at their mainnet addresses.
The vault is the one from #70, which adds `onReport`; nothing in this package changed.

### Setup

1. `anvil --fork-url https://arb1.arbitrum.io/rpc --port 8546 --auto-impersonate`, forked at
   block 502282713 (chain id stays 42161, which the deploy script insists on).
2. The vault, with #70's `Deploy.s.sol` from anvil's first account and
   `AGENT_ADDRESS=0x746182D0Cccc5CeFc69853bb0325C850029388C0 FORWARDER_ADDRESS=0xd770499057619c9a76205fd4168161cf94abc532`:
   proxy `0xBb636293b2fc0210DD29782FeeFbF1b62ECa1434`, `forwarder()` reads back the mock.
3. The owner, the throwaway wallet the plugins already use, funded on the fork with
   `anvil_setBalance` (ETH) and `anvil_setStorageAt` on ARB's balance mapping (slot 51 of the
   proxy, checked against `balanceOf` of the PoolManager first).
4. An out-of-range position, the approval, and the mandate, from a scratch Foundry script that
   mirrors the fork test's `_mintOutOfRangePosition` and `_mandate` (quoted below, never part of
   the build): tick 94473 at the time, range `[93270, 93470)` so the position held ARB only,
   token 202707, liquidity 93889598979339206088. Mandate: width 200 ticks, improvement 100 bps,
   cooldown 3600 s, cap `uint128.max`, expiry 1791244800, retain 5000 bps; hash
   `0xe43ef21b31ef6c5e044fdaa2661fd1f5061adbbde698cf5cf4c40fb7d52e7be3`, and
   `mandateHash()` in this package gives the same bytes from the same values.
5. The consumer: `project.yaml` staging RPC for `ethereum-mainnet-arbitrum-1` pointed at the
   fork, the six mandate secrets set to the values above, `CRE_ETH_PRIVATE_KEY` the owner's key
   (the CLI's broadcaster, not the DON), and this config:

```json
{
  "schedule": "0 */5 * * * *",
  "rpcUrl": "http://127.0.0.1:8546",
  "delivery": "forwarder",
  "chainSelectorName": "ethereum-mainnet-arbitrum-1",
  "vault": "0xBb636293b2fc0210DD29782FeeFbF1b62ECa1434",
  "positionManager": "0xd88F38F930b7952f2DB2432Cb002E7abbF3dD869",
  "stateView": "0x76Fd297e2D437cd7f76d50F01AfE6160f86e9990",
  "owner": "0x746182D0Cccc5CeFc69853bb0325C850029388C0",
  "poolId": "0xb37da7d5beb04539b6c497a15794748fc0ce1da7afc61133e3253eff76229ae5",
  "mandateHash": "0xe43ef21b31ef6c5e044fdaa2661fd1f5061adbbde698cf5cf4c40fb7d52e7be3",
  "gasLimit": "3000000",
  "slippageBps": 50,
  "maxPoolFeePips": 10000,
  "deadlineSeconds": 600
}
```

### Run

```
cre workflow simulate ./workflow --broadcast --target staging-settings --env .env --trigger-index 0 --non-interactive
```

Binary hash `a01c5adafcc86fc8f4bf1868a4eb72eab3fed686ed04931fe326b67a90956711`, config hash
`46ac87147bcacc9753b544c330c8b77c299702317642ac480d442f0525a933d3`. Result:

```
"RECENTER 94370..94570 tx 0xf80b87f2d30afa0796ee1e44b6cc13d23739a40a6a70c1f0c3e99adc3d8add48"
```

A second run, straight after: `"HOLD (cooldown)"`, and no transaction.

### What the fork says afterwards

| | |
|---|---|
| Transaction | status 1, to the mock forwarder, selector `0x11289565` (`report`), 579,275 gas, 13 logs, one of them the vault's `Recentred` |
| `positionOf(owner)` | 202708, was 202707; `ownerOf(202708)` is the owner; `ownerOf(202707)` reverts, burned |
| New range | `[94370, 94570)`, containing tick 94505 (the vault's swap moved it from 94473) |
| Liquidity | 88545095207060353974 of 93889598979339206088 retained, 94.3%, above the 50% floor |
| `lastActionAt(owner)` | 1788684124, which is what the second run held on |
| Vault balances after | 0 ETH, 0 ARB |

### What this does and does not show

It shows the delivery path: the report tuple this package encodes is the tuple the vault
decodes, `onReport` runs the same `_recenter` the fork tests exercise, and the enclave's sizing
produced a move the vault accepted on a real pool at real depth. It does not show DON
authorisation: the simulator is not a TEE, and the mock forwarder verifies no signatures. It is
also a fork, not a live network; #21 is the same run against a deployed vault through the
production forwarder, once the vault is deployed and the workflow can be.

<details>
<summary>The scratch script, for reproduction</summary>

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Scratch-only rehearsal helper, never committed: mints an out-of-range position for the
// broadcaster on the demo pool, approves the vault, and commits a mandate. Mirrors the fork
// test's `_mintOutOfRangePosition` and `_mandate`, with the token balance funded outside.
import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {HelicoVault} from "../src/HelicoVault.sol";
import {Mandate, MandateLib, PoolKey} from "../src/Mandate.sol";
import {IPositionManager} from "../src/IPositionManager.sol";
import {IStateView} from "../src/IStateView.sol";
import {TickMath} from "../src/lib/TickMath.sol";

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IPositionNft {
    function setApprovalForAll(address operator, bool approved) external;
}

contract Rehearse is Script {
    using MandateLib for PoolKey;
    using MandateLib for Mandate;

    IPositionManager constant POSITION_MANAGER = IPositionManager(0xd88F38F930b7952f2DB2432Cb002E7abbF3dD869);
    IStateView constant STATE_VIEW = IStateView(0x76Fd297e2D437cd7f76d50F01AfE6160f86e9990);
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    uint256 constant Q96 = 2 ** 96;
    uint8 constant MINT_POSITION = 0x02;
    uint8 constant SETTLE_PAIR = 0x0d;

    struct Plan {
        int24 tick;
        int24 lower;
        int24 upper;
        uint128 liquidity;
        uint256 tokenId;
    }

    function _pool() internal pure returns (PoolKey memory) {
        return PoolKey({
            currency0: address(0),
            currency1: 0x912CE59144191C1204E64559FE8253a0e49E6548,
            fee: 500,
            tickSpacing: 10,
            hooks: address(0)
        });
    }

    function _plan(PoolKey memory pool) internal view returns (Plan memory p) {
        (, p.tick,,) = STATE_VIEW.getSlot0(pool.hashPoolKey());
        p.upper = (p.tick / 10) * 10 - 10 * 100;
        p.lower = p.upper - 10 * 20;
        uint160 sa = TickMath.getSqrtPriceAtTick(p.lower);
        uint160 sb = TickMath.getSqrtPriceAtTick(p.upper);
        p.liquidity = uint128(Math.mulDiv(100 ether, Q96, sb - sa));
        p.tokenId = POSITION_MANAGER.nextTokenId();
    }

    function _mint(PoolKey memory pool, Plan memory p, address owner) internal {
        IERC20(pool.currency1).approve(PERMIT2, type(uint256).max);
        IPermit2(PERMIT2).approve(pool.currency1, address(POSITION_MANAGER), type(uint160).max, uint48(block.timestamp + 1 days));
        bytes memory actions = abi.encodePacked(MINT_POSITION, SETTLE_PAIR);
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(pool, p.lower, p.upper, uint256(p.liquidity), type(uint128).max, type(uint128).max, owner, bytes(""));
        params[1] = abi.encode(pool.currency0, pool.currency1);
        POSITION_MANAGER.modifyLiquidities(abi.encode(actions, params), block.timestamp + 600);
    }

    function _mandate(PoolKey memory pool, uint64 expiry) internal pure returns (Mandate memory) {
        return Mandate({
            poolId: pool.hashPoolKey(),
            rangeWidthTicks: 200,
            minImprovementBps: 100,
            cooldownSeconds: 3600,
            maxLiquidity: type(uint128).max,
            expiry: expiry,
            minRetainedBps: 5000
        });
    }

    function run() external {
        HelicoVault vault = HelicoVault(payable(vm.envAddress("VAULT")));
        uint64 expiry = uint64(vm.envUint("EXPIRY"));
        PoolKey memory pool = _pool();
        Plan memory p = _plan(pool);
        Mandate memory m = _mandate(pool, expiry);

        vm.startBroadcast();
        _mint(pool, p, msg.sender);
        IPositionNft(address(POSITION_MANAGER)).setApprovalForAll(address(vault), true);
        vault.setMandate(p.tokenId, m);
        vm.stopBroadcast();

        console.log("tick now      ", p.tick);
        console.log("token id      ", p.tokenId);
        console.log("range lower   ", p.lower);
        console.log("range upper   ", p.upper);
        console.log("liquidity     ", p.liquidity);
        console.logBytes32(m.hash());
    }
}
```

</details>

