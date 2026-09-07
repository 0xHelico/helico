# An Aqua app where the strategy is the mandate

Issue #147. Written **before** the contract, which is the point: if something about Aqua does not
behave the way its repository suggests, this document should be the thing that turns out to be
wrong, not three days of Solidity.

## What the owner asked for

Verbatim, in translation, in the order it was given:

1. *"Start, build it to completion, make sure every test is covered and runs smoothly."*
2. *"Cover every case — positive, negative and edge. All of them."*
3. *"Tell rifky we are starting on Aqua."*
4. *"Spawn multiple agents so the work is detailed and can be validated."*

And the argument that decided it, which is his and which I had been arguing against:

> *"We already struggled to find v4 hooks with good liquidity and generic tokens rather than
> junk ones — that alone was hard. What happens when the next obstacle comes? Uniswap is harder
> to control."*

## Why that argument won

It is correct, and the evidence for it is a day of our own work.

Proving the vault works in a pool that has hooks meant finding somebody else's pool with real
liquidity on a pair anyone recognises. Two scans concluded there was none on Arbitrum. That
conclusion was **wrong** — `LimitOrderHook` is there, in Uniswap's own registry — but the cost of
being wrong was hours, and what we found was a hook that refuses swaps outright and another whose
authorised range is a single tick.

None of that is bad luck. It is what depending on liquidity you did not create feels like.

Aqua inverts it. From 1inch's own `examples/test/XYCSwap.t.sol`:

```solidity
aqua        = new Aqua();
xycSwapImpl = new XYCSwap(aqua);
token0      = new MockERC20("Token0", "TK0");
vm.prank(maker); token0.approve(address(aqua), type(uint256).max);
vm.prank(maker); aqua.ship(...);
```

**We are the maker.** The liquidity, the tokens and the app are ours. The only thing we do not
control is Aqua and SwapVM themselves, which are deployed at
`0x111111338c5091e8440b67b168bae16a668ac0de` across sixteen chains including Arbitrum One —
verified with `eth_getCode`, 41,085 characters.

## The idea

Aqua already has the shape Helico argues for, and we did not put it there.

| Helico today | Aqua |
|---|---|
| a mandate the owner commits on chain | a **strategy** the maker `ship`s |
| `keccak256(abi.encode(mandate))`, which the vault refuses to act outside of | `strategyHash`, which the protocol enforces as **immutable** |
| the vault reverts when the agent steps outside | the **app** is the swap logic, so it reverts |

So the app is not Helico bolted onto Aqua. **The strategy carries the limits, and the swap path
refuses to exceed them.** Shipping is the commitment; the app is the enforcement.

## The contract

`HelicoMandateSwap`, an `AquaApp` in the shape of `XYCSwap` — constant product, maker fee — with
the owner's limits in the strategy and checked in the swap path:

```solidity
struct Strategy {
    address maker;          // whose liquidity
    address token0;
    address token1;
    uint256 feeBps;         // the maker's fee
    uint256 maxNotionalIn;  // per-swap ceiling, in the input token's smallest unit
    uint64  expiry;         // no swap at or after this
    address agent;          // if non-zero, only this address may take
    bytes32 salt;
}
```

Four refusals, each its own error, each with a test that fails when the check is deleted.

The struct was **under review rather than settled** when this was written, and two questions were
open: whether `maxNotionalIn` is meaningful when either token can be the input, and how an owner
rotates `agent` when Aqua makes strategies immutable. Both came back with an answer, and the first
one changed the struct. What shipped is in the next section; this block is left as written so the
change is legible rather than invisible.

## What the review returned, and what it changed

The three passes finished. All of them ran code rather than reading it, and two of the answers
changed the struct above before it was written.

**`maxNotionalIn` was the wrong limit, on the wrong side.** Two objections, both correct:

- *Wrong units.* Either token can be the input, so one scalar has to mean two things. `1000e6` is
  1000 USDC in one direction and 10^-12 WETH in the other.
- *Wrong side.* A maker's loss is in what they hand over. An input ceiling bounds the output only
  through the curve — and the curve can be made to pay out everything.

That last point came with a measurement. Aqua's `ship` validates nothing, and a strategy shipped
with a zero amount on one side is **active**. Constant product then reads
`amountOut = amountIn * balanceOut / (0 + amountIn)`, which is the entire opposite reserve, for two
wei of input. No input ceiling is small enough to notice, because the number it checks is not the
number that is wrong.

So `maxNotionalIn` became `maxOut0` and `maxOut1`, per token, on the way out — and a
`DegenerateReserves` check refuses a swap whose reserves cannot support one.

**`agent` cannot mean an EOA, and this is not our choice.** solc emits an `EXTCODESIZE` check
before a high-level call to a function with no return value, so the taker callback can only land
on a contract. An EOA taker reverts with or without a gate. The consequence for tests is sharper
than the consequence for the design: a negative test using a plain address would pass against a
contract with no gate at all. Every refusal test therefore uses a funded, approved callback
contract, and the agent test has a control — the *same* contract succeeding once a mandate names
it.

**Rotation stays expensive, and stays.** Changing `agent` means `dock` plus a re-ship under a new
salt, because Aqua freezes a strategy for the lifetime of its hash and docking burns that hash
permanently. The proper fix is an EIP-712 signature from the agent, with the key outside the
strategy. That is a larger change than this app needs today, and it is written down here rather
than discovered later.

**One thing the plan got right and the review confirmed:** liquidity never moves. `ship` transfers
nothing, `pull` sends maker to recipient directly, `push` sends payer to maker directly. Aqua is
never even an intermediary. A test asserts that Aqua and the app both hold zero before and after.

Two further limits are now documented by tests rather than by prose, because both are the kind of
claim that would be a disqualification if a README overstated it:

- **The ceiling is per swap, not a budget.** The lock is released when each call returns, so a
  loop in one transaction multiplies it freely.
- **Fee-on-transfer tokens desync the ledger.** `push` credits the nominal amount while the maker
  receives less. Measured, not assumed.

### The suite, and why it is believed

28 tests, against a real Aqua deployed in `setUp` — nothing mocks Aqua or the app. Then every
guard was cut out, one at a time, and the suite re-run. All 11 mutations are caught.

The reentrancy mutation is the one worth recording. Deleting the modifier makes
`_safeCheckAquaPush` revert with `MissingNonReentrantModifier`, so *every* test fails and none of
them say anything about the attack. Cutting the guard **and** inlining the identical balance check
leaves a contract that looks correct — and then exactly one test fails, on *"did not revert as
expected"*, because two overlapping swaps snapshot the same balance and one payment satisfies both.

## What is being validated in parallel, and why separately

Three passes, deliberately independent, each able to contradict what is written here:

1. **Can we compile against Aqua at all** — their project is solc 0.8.30 with `via_ir`; ours is
   0.8.28 without. This runs in an isolated worktree and reports a recipe, not a hack.
2. **What Aqua actually does** — the lifecycle of `ship`, `pull`, `push`, `dock`, the reentrancy
   rules, and the ordering in `swapExactIn` where `pull` happens *before* the taker's payment is
   checked.
3. **The test matrix, derived without seeing mine** — including, explicitly, *"which cases would
   pass even if the feature were deleted"*.

The third question is asked first rather than last on purpose.

## What this does not do

- **It does not remove the Uniswap integration.** `HelicoVault` and its fork tests stay green.
  Prize tracks are chosen at submission, so both paths stay alive until the 12th and the choice is
  made from what is actually working rather than from what was hoped for.
- **It does not claim a track.** Whether a policy-shaped app satisfies *"create a custom Aqua app
  that implements a sophisticated DeFi position"*, or whether that track expects novel price
  discovery, is a question in front of 1inch. The answer changes the shape, not whether.
- **It does not touch the enclave yet.** The CRE workflow decides a tick question today; deciding
  an Aqua question instead is a separate change, and Chainlink's track depends on whichever one
  works on the 13th.
