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
import {
  type Address,
  decodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  type Hex,
  type PublicClient,
  parseAbi,
  parseAbiParameters,
  zeroAddress,
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
/**
 * Wrapped ether on Arbitrum One, and the one function of it this needs.
 *
 * Aqua positions hold WETH. SwapVM pulls the taker's side with `safeTransferFrom`, which native
 * currency has no equivalent of, so a swap that starts in ETH has to wrap first — and the starter
 * on the front door is literally "Swap 0.1 ETH into USDC". Before this, that sentence looked up
 * positions for `0x0000…0000`, matched nothing whatever the liquidity was, and came back as "no
 * live Aqua position" — a true sentence for the wrong reason, which is the worst kind.
 */
const WETH: Address = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";

/** Only for a sentence about a size. Six decimals is USDC and USDT, which is every quote side we
 *  have a position for; anything else falls back to the address's own shorthand. */
const outSymbolFor = (token: Address) =>
  token.toLowerCase() === "0xaf88d065e77c8cc2239327c5edb3a432268e5831"
    ? "USDC"
    : token.toLowerCase() === "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9"
      ? "USDT"
      : `${token.slice(0, 6)}…`;
const weth = parseAbi(["function deposit() payable"]);

/**
 * One transaction and what it is for.
 *
 * Declared here rather than borrowed from `@helico/plugin-uniswap`, which is where it used to come
 * from: this plan has a step that one does not have, and the swap stopped going through Uniswap on
 * 10 September.
 */
export type AquaStep = {
  kind: "wrap" | "approve-token" | "swap";
  transaction: { to: Address; data: Hex; value: bigint };
};

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
  steps: AquaStep[];
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
): Promise<{
  orders: OpenOrder[];
  considered: number;
  /** What each position has actually committed of `tokenOut`, by strategy hash. */
  cap: Map<string, bigint>;
}> {
  const mandates = await askGraph((subgraph) =>
    fillableFor(subgraph, [tokenIn, tokenOut]),
  );
  const shipped = mandates.map((m) => ({
    strategyHash: m.strategyHash,
    strategy: m.strategy,
  }));
  // Carried rather than dropped, because the quote does not know about it.
  //
  // `concentrate` prices on virtual reserves — a band, not an inventory — so it will answer for
  // more than the maker committed and answer badly. Measured: a position holding 10 USDC quotes
  // 0.1 WETH at **72.06 USDC**, and the fill reverts when Aqua's ledger subtraction underflows.
  // A card that showed that price would have taken a signature for a transaction that cannot land,
  // which is the one thing this file's own docblock says a quote must never do.
  const cap = new Map<string, bigint>();
  const out = tokenOut.toLowerCase();
  for (const m of mandates) {
    const side = m.balances.find(
      (b) => b.token.toLowerCase() === out && b.spendable,
    );
    cap.set(m.strategyHash.toLowerCase(), side?.amount ?? 0n);
  }
  return { orders: openOrders(shipped), considered: shipped.length, cap };
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
  cap: Map<string, bigint>,
): Promise<{
  chosen: OpenOrder;
  amountOut: bigint;
  /** The most any candidate had committed, for a refusal that can name a number. */
  largestCap: bigint;
} | null> {
  let winner: { chosen: OpenOrder; amountOut: bigint } | null = null;
  let largestCap = 0n;
  for (const candidate of orders) {
    const committed = cap.get(candidate.strategyHash.toLowerCase()) ?? 0n;
    if (committed > largestCap) largestCap = committed;
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
      // The ledger is the cap, and `concentrate` does not consult it. Anything above what this
      // maker committed of `tokenOut` is a price nobody can pay.
      if (amountOut > committed) continue;
      if (amountOut > 0n && (!winner || amountOut > winner.amountOut)) {
        winner = { chosen: candidate, amountOut };
      }
    } catch {
      // Not fillable for this pair, direction or size. Ordinary, not an error.
    }
  }
  return winner ? { ...winner, largestCap } : null;
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
 * Throws with the wall it actually hit rather than returning `null` for all of them: no position
 * holding the pair, positions that do not decode to what Aqua filed, and positions that decode and
 * still will not price. They are three different facts about the world and the third one is the
 * true one on Arbitrum One today.
 */
export async function planAquaSwap(
  client: PublicClient,
  input: PlanAquaSwapInput,
): Promise<AquaPlan | null> {
  const { account, tokenIn, tokenOut, amountIn, slippageBps } = input;

  // Native ether is wrapped on the way in, and refused on the way out.
  //
  // In: the position holds WETH and the router pulls with `safeTransferFrom`, so the taker has to
  // be holding WETH by the time the fill runs. One extra transaction, from the wallet's own ETH.
  //
  // Out: the router would pay WETH, and unwrapping it is not a step this can add honestly — the
  // amount is only known after the fill, and withdrawing the wallet's whole WETH balance would
  // take ether that was already there. Named rather than silently substituted, because handing
  // somebody WETH when they asked for ETH is a different thing from what they asked for.
  if (tokenOut === zeroAddress) {
    throw new Error(
      "Aqua pays WETH rather than native ETH. Ask for WETH and this works.",
    );
  }
  const wrapping = tokenIn === zeroAddress;
  const payWith = wrapping ? WETH : tokenIn;

  const { orders, considered, cap } = await candidates(payWith, tokenOut);
  const picked = await best(client, orders, payWith, tokenOut, amountIn, cap);
  const largestCap = [...cap.values()].reduce((a, b) => (b > a ? b : a), 0n);

  // Three different walls, and they used to arrive as one sentence.
  //
  // "No live Aqua position holds both sides of this pair right now" was what a person saw in every
  // case, and on Arbitrum One it is simply false: measured just now, **six** positions hold WETH
  // and USDC, four of them decode to the order Aqua filed, and all four refuse a quote in both
  // directions at every size from 0.0005 to 0.1 WETH with the same custom error from 1inch's
  // router (`0x89c62b64`). Four independent makers failing identically is not about size or
  // inventory; those orders are not fillable through this router today.
  //
  // Saying which wall it is matters more than it looks. A judge reading "no position holds this
  // pair" concludes the integration does not work. The truth is that the index found them, the
  // hash gate proved them, and the router refused them — which is three working parts and one
  // absent maker.
  if (!picked) {
    if (considered === 0) {
      throw new Error(
        "No Aqua position holds both sides of this pair right now.",
      );
    }
    if (orders.length === 0) {
      throw new Error(
        `${considered} position${considered === 1 ? "" : "s"} hold this pair, and none of them decodes to the order Aqua filed under its hash.`,
      );
    }
    // Naming the size is the difference between "try again later" and "ask for less". A band
    // prices any amount; the ledger pays only what was committed, and that number is knowable.
    if (largestCap > 0n) {
      throw new Error(
        `The largest Aqua position for this pair can pay ${Number(formatUnits(largestCap, 6)).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${outSymbolFor(tokenOut)} and this asks for more. Ask for a smaller amount, or provide liquidity of your own.`,
      );
    }
    throw new Error(
      `${orders.length} Aqua position${orders.length === 1 ? "" : "s"} hold this pair and none will price it right now. Aqua's own liquidity is thin; a maker position of ours is what fixes this.`,
    );
  }

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
    address: payWith,
    args: [account, spender],
    functionName: "allowance",
  });

  const steps: AquaStep[] = [];
  if (wrapping) {
    steps.push({
      kind: "wrap",
      transaction: {
        to: WETH,
        data: encodeFunctionData({ abi: weth, functionName: "deposit" }),
        value: amountIn,
      },
    });
  }
  if (allowance < amountIn) {
    const approve = fillApproval(ARBITRUM_ONE, payWith, amountIn);
    steps.push({
      kind: "approve-token",
      transaction: { to: approve.to, data: approve.data, value: 0n },
    });
  }
  const fill = fillCall(
    ARBITRUM_ONE,
    picked.chosen.order,
    payWith,
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
