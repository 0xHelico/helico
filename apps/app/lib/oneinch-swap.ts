"use client";

import {
  aggregationSpender,
  approveTransaction,
  ONEINCH_NATIVE,
  oneInchToken,
  swapTransaction,
} from "@helico/plugin-1inch";
import { type Address, erc20Abi, type PublicClient } from "viem";

import type { AquaStep } from "@/lib/aqua-swap";

/**
 * The swap for when no maker's mandate can pay: 1inch's aggregation route, through our own server.
 *
 * **Why this replaced Uniswap v4 rather than joining it.** Until today the fallback was Uniswap,
 * for one reason only — the aggregation API needs a key and we had none, while the v4 Quoter is an
 * on-chain call. We have a key now, and Uniswap has not been a submitted track since 7 September,
 * so the product's most visible action was ending at a protocol we do not submit. The v4 code and
 * its tests stay exactly where they are; they are simply not in this path.
 *
 * **The key is not here.** Every request goes to `/api/1inch/…`, a route handler on our own server
 * that adds the header and forwards six allowlisted shapes. Nothing in this file, and nothing
 * bundled with it, can name the key.
 *
 * **Native ether needs no wrapping here**, which is the one place this path is shorter than the
 * Aqua one: the aggregation router takes ETH directly, while an Aqua fill pulls WETH with
 * `safeTransferFrom` and so has to wrap first.
 */

/** Our server, which is the only thing holding the key. Paths begin with a slash. */
const viaProxy = (path: string) => fetch(`/api/1inch${path}`);

export type OneInchPlan = {
  amountIn: bigint;
  amountOut: bigint;
  minAmountOut: bigint;
  slippageBps: number;
  /** In the order they must be sent. One entry when the allowance already covers it. */
  steps: AquaStep[];
  /** The router the approval points at, asked for rather than hardcoded. */
  spender: Address;
};

export type PlanOneInchSwapInput = {
  chainId: number;
  account: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  slippageBps: number;
  /**
   * Where the output goes when it is not the sender. The put-to-work batch swaps ETH straight into
   * the Helico account it opens in the same batch, so nothing has to be moved afterwards.
   */
  receiver?: Address;
};

export async function planOneInchSwap(
  client: PublicClient,
  input: PlanOneInchSwapInput,
): Promise<OneInchPlan> {
  const src = oneInchToken(input.tokenIn);
  const dst = oneInchToken(input.tokenOut);
  if (input.amountIn <= 0n) {
    throw new Error("There is no amount to swap.");
  }

  const spender = await aggregationSpender(viaProxy, input.chainId);
  const steps: AquaStep[] = [];

  // Ether needs no allowance; a token does, and the allowance that already exists is read from the
  // chain rather than assumed absent. Asking for an approval a person already gave is a signature
  // spent on nothing.
  if (src !== (ONEINCH_NATIVE as Address)) {
    const allowance = (await client.readContract({
      abi: erc20Abi,
      address: src,
      args: [input.account, spender],
      functionName: "allowance",
    })) as bigint;
    if (allowance < input.amountIn) {
      const approval = await approveTransaction(viaProxy, {
        amount: input.amountIn,
        chainId: input.chainId,
        token: src,
      });
      steps.push({
        kind: "approve-token",
        transaction: {
          data: approval.data,
          to: approval.to,
          value: approval.value,
        },
      });
    }
  }

  // The simulation is skipped, always, and for two reasons rather than convenience.
  //
  // **The approval above has not run yet.** The API refuses to build a swap it cannot simulate, so
  // a plan whose first step is the approval could not exist until that step had already landed —
  // and a plan that cannot exist cannot be shown to somebody before they agree to it. The ordering
  // is what makes that safe: by the time the fill is sent, the approval has been mined.
  //
  // **And 1inch simulates against the chain its own node sees, which is not always the chain the
  // wallet is on.** Measured: a wallet holding 0.1 ETH on a fork of Arbitrum One is refused
  // `NOT_ENOUGH_BALANCE` with `Balance: 0`, because mainnet has never heard of it. Letting that
  // opinion decide would refuse a swap the wallet can pay. The authoritative check is the card's
  // own `shortfall`, read from the chain the person is actually connected to.
  const fill = await swapTransaction(viaProxy, {
    amount: input.amountIn,
    chainId: input.chainId,
    dst,
    from: input.account,
    receiver: input.receiver,
    skipSimulation: true,
    slippageBps: input.slippageBps,
    src,
  });
  steps.push({
    kind: "swap",
    transaction: { data: fill.data, to: fill.to, value: fill.value },
  });

  return {
    amountIn: input.amountIn,
    amountOut: fill.amountOut,
    // What 1inch put in the calldata is its own `minReturn`; this is the same arithmetic for the
    // number on screen, so the figure a person reads is the floor the transaction enforces.
    minAmountOut:
      (fill.amountOut * BigInt(10_000 - input.slippageBps)) / 10_000n,
    slippageBps: input.slippageBps,
    spender,
    steps,
  };
}
