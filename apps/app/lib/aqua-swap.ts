"use client";

import {
  ARBITRUM_ONE,
  fillApproval,
  fillCall,
  type OpenOrder,
  openOrders,
  quoteCall,
  swapVmAddress,
} from "@helico/plugin-1inch";
import { fillableFor } from "@helico/plugin-thegraph";
import type { SwapStep } from "@helico/plugin-uniswap";
import {
  type Address,
  decodeAbiParameters,
  erc20Abi,
  parseAbiParameters,
  type PublicClient,
} from "viem";

import { askGraph } from "@/lib/mandates";

/**
 * A swap the wallet fills itself, against somebody's Aqua position.
 *
 * **Why this exists beside the Uniswap planner.** The chat's swap went through Uniswap v4, which
 * works and is a competitor's protocol on screen in a submission whose tracks are Chainlink, 1inch
 * and The Graph — and it was the one part of the product where neither 1inch nor The Graph carried
 * any weight. Here both do: the fill is 1inch's SwapVM, and the candidates can only be found
 * through the index.
 *
 * **The wallet is the taker, with no contract in between.** `SwapVM.swap()` is `external`, takes
 * no callback and reads the taker off `msg.sender`. The taker-contract requirement belongs to
 * `HelicoMandateSwap`, not to Aqua — so this is one approval and one transaction, the shape any
 * DEX has.
 */
export type AquaPlan = {
  /** The position being filled, and the hash Aqua files it under. */
  chosen: OpenOrder;
  /** How many live candidates the index offered before quoting. */
  considered: number;
  /** How many of those were actually the order they claimed to be. */
  valid: number;
  amountIn: bigint;
  amountOut: bigint;
  minAmountOut: bigint;
  slippageBps: number;
  deadline: bigint;
  /** In the order they must be sent. One entry when the allowance already covers it. */
  steps: SwapStep[];
};

/**
 * Every live position holding both sides of the pair, decoded, and proven to be what it says.
 *
 * Two filters, and the second is the one that is easy to leave out. Aqua accepts arbitrary bytes
 * and never interprets them, so `Order.decode` succeeding means the bytes have the right *shape* —
 * not that they are the order Aqua filed under that hash. Measured on Arbitrum One: of eleven live
 * strategies that decoded cleanly, **six hashed to something else**. Offering those to a wallet is
 * offering orders that do not exist, and the wallet finds out by paying gas.
 */
async function candidates(
  tokenIn: Address,
  tokenOut: Address,
): Promise<{ orders: OpenOrder[]; considered: number }> {
  const mandates = await askGraph((subgraph) =>
    fillableFor(subgraph, [tokenIn, tokenOut]),
  );
  const shipped = mandates.map((m) => ({
    strategyHash: m.strategyHash,
    strategy: m.strategy,
  }));
  return { orders: openOrders(shipped), considered: shipped.length };
}

/**
 * Ask the deployed SwapVM what each candidate would pay, and keep the best.
 *
 * A quote is the only honest test that a position is fillable: it reads Aqua's ledger, so it fails
 * for a docked strategy, one whose maker's wallet no longer covers the commitment, and one shipped
 * under bytes that hash differently. A candidate that reverts here is dropped rather than reported
 * — most strategies on Aqua belong to other apps, and that is ordinary.
 */
async function best(
  client: PublicClient,
  orders: OpenOrder[],
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
): Promise<{ chosen: OpenOrder; amountOut: bigint } | null> {
  let winner: { chosen: OpenOrder; amountOut: bigint } | null = null;
  for (const candidate of orders) {
    try {
      const call = quoteCall(
        ARBITRUM_ONE,
        candidate.order,
        tokenIn,
        tokenOut,
        amountIn,
      );
      const res = await client.call({ to: call.to, data: call.data });
      if (!res.data) continue;
      const [, amountOut] = decodeAbiParameters(
        parseAbiParameters("uint256, uint256"),
        res.data,
      );
      if (amountOut > 0n && (!winner || amountOut > winner.amountOut)) {
        winner = { chosen: candidate, amountOut };
      }
    } catch {
      // Not fillable for this pair, direction or size. Ordinary, not an error.
    }
  }
  return winner;
}

export type PlanAquaSwapInput = {
  account: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  slippageBps: number;
  /** Seconds the quote stays good for once signed. */
  ttlSeconds?: number;
};

/**
 * Find a position, price it, and return the transactions that fill it.
 *
 * Returns `null` when nothing quotes, which is a real answer rather than a failure: live Aqua
 * liquidity is thin and pair-specific, and the caller should say so rather than show a spinner.
 */
export async function planAquaSwap(
  client: PublicClient,
  input: PlanAquaSwapInput,
): Promise<AquaPlan | null> {
  const { account, tokenIn, tokenOut, amountIn, slippageBps } = input;
  const { orders, considered } = await candidates(tokenIn, tokenOut);
  const picked = await best(client, orders, tokenIn, tokenOut, amountIn);
  if (!picked) return null;

  const minAmountOut =
    (picked.amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
  const deadline =
    BigInt(Math.floor(Date.now() / 1000)) + BigInt(input.ttlSeconds ?? 300);

  // The allowance goes to the **router**, not to Aqua, and getting that backwards is a reverted
  // transaction with nothing useful in it. `SwapVM.sol:243` calls `_transferFrom(taker, …,
  // useAqua = false)` with the flag hardcoded, so the taker's side is a plain `safeTransferFrom`
  // by the router; only the maker's side goes through `AQUA.pull`.
  const spender = swapVmAddress(ARBITRUM_ONE) as Address;
  const allowance = await client.readContract({
    abi: erc20Abi,
    address: tokenIn,
    args: [account, spender],
    functionName: "allowance",
  });

  const steps: SwapStep[] = [];
  if (allowance < amountIn) {
    const approve = fillApproval(ARBITRUM_ONE, tokenIn, amountIn);
    steps.push({
      kind: "approve-token",
      transaction: { to: approve.to, data: approve.data, value: 0n },
    });
  }
  const fill = fillCall(
    ARBITRUM_ONE,
    picked.chosen.order,
    tokenIn,
    tokenOut,
    amountIn,
    minAmountOut,
    deadline,
  );
  steps.push({
    kind: "swap",
    transaction: { to: fill.to, data: fill.data, value: 0n },
  });

  return {
    chosen: picked.chosen,
    considered,
    valid: orders.length,
    amountIn,
    amountOut: picked.amountOut,
    minAmountOut,
    slippageBps,
    deadline,
    steps,
  };
}
