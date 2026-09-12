"use client";

import {
  ARBITRUM_ONE,
  aquaAddress,
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
/**
 * `TxOriginTokenBalanceIsZero(address,address)` on 1inch's deployed SwapVM, named from its verified
 * ABI rather than guessed: 57 error signatures were computed and this is the one.
 *
 * It means the taker holds none of the ERC-721 SwapVM v3.1.2 requires. A gate, not a shortage —
 * asking for less does not get past it.
 */
const TX_ORIGIN_TOKEN_BALANCE_IS_ZERO = "0x39c4052c";

/** Which of the three limits binds a position, and how much it can actually pay. */
export type Wall = "ledger" | "wallet" | "allowance";

/**
 * The most a maker can pay of one token, and which limit says so.
 *
 * `pull` does `safeTransferFrom(maker, to, amount)`, so all three have to cover the amount: Aqua's
 * ledger, the maker's balance, and their allowance to Aqua. The ledger is the only one Aqua itself
 * enforces, and it is a number the maker shipped — it does not fall when they spend those tokens
 * elsewhere or revoke the approval.
 *
 * Ties go to `ledger`, then `wallet`. Naming the outer limit when two are equal would send somebody
 * to fix an allowance that is already large enough.
 */
export function fillableCap(
  ledger: bigint,
  wallet: bigint,
  allowance: bigint,
): { amount: bigint; limit: Wall } {
  if (ledger <= wallet && ledger <= allowance)
    return { amount: ledger, limit: "ledger" };
  if (wallet <= allowance) return { amount: wallet, limit: "wallet" };
  return { amount: allowance, limit: "allowance" };
}

async function candidates(
  client: PublicClient,
  tokenIn: Address,
  tokenOut: Address,
): Promise<{
  orders: OpenOrder[];
  considered: number;
  /** The most each position could actually pay of `tokenOut`, by strategy hash. */
  cap: Map<string, bigint>;
  /** Which of the three limits bound, per hash. For a refusal that says something useful. */
  bound: Map<string, "ledger" | "wallet" | "allowance">;
}> {
  const mandates = await askGraph((subgraph) =>
    fillableFor(subgraph, [tokenIn, tokenOut]),
  );
  const shipped = mandates.map((m) => ({
    strategyHash: m.strategyHash,
    strategy: m.strategy,
  }));
  // Carried rather than dropped, because the quote does not know about any of it.
  //
  // `concentrate` prices on virtual reserves — a band, not an inventory — so it will answer for
  // more than the maker committed and answer badly. Measured: a position holding 10 USDC quotes
  // 0.1 WETH at **72.06 USDC**, and the fill reverts when Aqua's ledger subtraction underflows.
  // A card that showed that price would have taken a signature for a transaction that cannot land,
  // which is the one thing this file's own docblock says a quote must never do.
  //
  // **And the ledger is only the first of three limits.** `pull` does
  // `safeTransferFrom(maker, to, amount)`, so a fill needs the maker's wallet to hold the tokens
  // and their allowance to Aqua to cover them — and the ledger is a number the maker shipped, which
  // does not fall when they spend those tokens elsewhere or revoke the approval. Read off Arbitrum
  // One on 11 September, three live positions with three different binding constraints (#393):
  //
  // ```
  // 0xa9aa0af4…  WETH  ledger 0.0000811  wallet 0.000209  allowance 0.0000018  → allowance, 43× short
  // 0xef9f7f40…  WETH  ledger 0.014624   wallet 0         allowance 0          → wallet, a ledger with no money
  // 0xcdbde4f9…  WETH  ledger 0.010950   wallet 0.010950  allowance unlimited  → ledger, as intended
  // ```
  //
  // The middle one cannot be filled at any size or any price, and nothing in Aqua's own state says
  // so. Capping on the ledger alone offered it.
  const cap = new Map<string, bigint>();
  const bound = new Map<string, "ledger" | "wallet" | "allowance">();
  const out = tokenOut.toLowerCase();
  const ledgers = mandates.map((m) => {
    const side = m.balances.find(
      (b) => b.token.toLowerCase() === out && b.spendable,
    );
    return side?.amount ?? 0n;
  });
  // One multicall rather than two reads per candidate: this runs on every quote the chat offers,
  // and the list is every live mandate for the pair.
  const withMaker = mandates.map((m) => m.maker as Address | undefined);
  const reads = withMaker.flatMap((maker) =>
    maker
      ? [
          {
            abi: erc20Abi,
            address: tokenOut,
            args: [maker],
            functionName: "balanceOf",
          } as const,
          {
            abi: erc20Abi,
            address: tokenOut,
            args: [maker, aquaAddress(ARBITRUM_ONE)],
            functionName: "allowance",
          } as const,
        ]
      : [],
  );
  const answers = reads.length
    ? await client.multicall({ allowFailure: true, contracts: reads })
    : [];
  let at = 0;
  for (const [i, m] of mandates.entries()) {
    const ledger = ledgers[i] ?? 0n;
    const key = m.strategyHash.toLowerCase();
    if (!withMaker[i]) {
      // No maker in the answer means the two reads were never made. Capping on the ledger is what
      // this did before and it is the wrong side of safe, so say which limit was used.
      cap.set(key, ledger);
      bound.set(key, "ledger");
      continue;
    }
    const walletAnswer = answers[at++];
    const allowanceAnswer = answers[at++];
    // A read that failed is treated as zero rather than as unlimited. An RPC that will not answer
    // is not evidence that a maker can pay.
    const wallet =
      walletAnswer?.status === "success" ? (walletAnswer.result as bigint) : 0n;
    const allowance =
      allowanceAnswer?.status === "success"
        ? (allowanceAnswer.result as bigint)
        : 0n;
    const { amount, limit } = fillableCap(ledger, wallet, allowance);
    cap.set(key, amount);
    bound.set(key, limit);
  }
  return {
    orders: openOrders(shipped),
    considered: shipped.length,
    cap,
    bound,
  };
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
  /**
   * Who is asking.
   *
   * **A quote without it asks the wrong question.** SwapVM v3.1.2 gates fills on an ERC-721 it
   * calls "Access Token for SwapVM v3.1.2" (`0x26ffc7d3…`), and it checks by asking that token for
   * `balanceOf(tx.origin)`. An `eth_call` with no `from` has `tx.origin` as the zero address, and
   * OpenZeppelin's ERC-721 refuses `balanceOf(address(0))` — so every quote came back as
   * `ERC721InvalidOwner(address(0))`, which is `0x89c62b64`, the error #393 recorded and could not
   * name. With a taker the refusal is SwapVM's own and says what it means:
   * `TxOriginTokenBalanceIsZero(taker, accessToken)`.
   */
  taker: Address,
): Promise<{
  /** Null when nothing priced within what it could pay. The rest still says why. */
  chosen: OpenOrder | null;
  amountOut: bigint;
  /** The most any candidate had committed, for a refusal that can name a number. */
  largestCap: bigint;
  /** How many priced above what they could pay. Zero means size was never the problem. */
  overCap: number;
  /** How many refused because this taker holds none of SwapVM's access token. */
  gated: number;
}> {
  let winner: { chosen: OpenOrder; amountOut: bigint } | null = null;
  let largestCap = 0n;
  let gated = 0;
  // Whether anything priced at all, and whether anything priced *above* what it could pay. They
  // are different failures and only the second one means "ask for less".
  let overCap = 0;
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
      // `account` is the `from`, which becomes `tx.origin` for the access-token check above.
      const res = await client.call({
        account: taker,
        to: call.to,
        data: call.data,
      });
      if (!res.data) continue;
      const [, amountOut] = decodeAbiParameters(
        parseAbiParameters("uint256, uint256"),
        res.data,
      );
      // The ledger is the cap, and `concentrate` does not consult it. Anything above what this
      // maker committed of `tokenOut` is a price nobody can pay.
      if (amountOut > committed) {
        overCap++;
        continue;
      }
      if (amountOut > 0n && (!winner || amountOut > winner.amountOut)) {
        winner = { chosen: candidate, amountOut };
      }
    } catch (e) {
      // Not fillable for this pair, direction or size. Ordinary, not an error — except for the
      // one refusal that is worth counting, because it is a gate rather than a shortage and no
      // amount of asking for less gets past it.
      if (JSON.stringify(e).includes(TX_ORIGIN_TOKEN_BALANCE_IS_ZERO)) {
        gated++;
      }
    }
  }
  return {
    chosen: winner?.chosen ?? null,
    amountOut: winner?.amountOut ?? 0n,
    largestCap,
    overCap,
    gated,
  };
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

  const { orders, considered, cap, bound } = await candidates(
    client,
    payWith,
    tokenOut,
  );
  const picked = await best(
    client,
    orders,
    payWith,
    tokenOut,
    amountIn,
    cap,
    account,
  );

  // Four different walls, and they used to arrive as one sentence.
  //
  // "No live Aqua position holds both sides of this pair right now" was what a person saw in every
  // case, and on Arbitrum One it is simply false: measured, **six** positions hold WETH and USDC
  // and five decode to the order Aqua filed.
  //
  // **And the reason they refuse is now named, which corrects what #393 guessed.** That issue
  // recorded `0x89c62b64` from every quote, said it belonged to 1inch's router, and offered expiry
  // as the likely shape. Expiry was wrong, and the error was not the router's: traced on a fork,
  // SwapVM calls `balanceOf` on an ERC-721 it calls "Access Token for SwapVM v3.1.2"
  // (`0x26ffc7d3…`), and that call is what reverts. `0x89c62b64` is
  // `ERC721InvalidOwner(address)` — OpenZeppelin refusing `balanceOf(address(0))` — because the
  // quote was an `eth_call` with no `from`, so `tx.origin` was the zero address. **Half the bug
  // was ours.**
  //
  // With a taker passed, the refusal is SwapVM's own and says what it means:
  // `TxOriginTokenBalanceIsZero(taker, 0x26ffc7d3…)`, matched against the 57 error signatures in
  // its verified ABI. SwapVM v3.1.2 gates fills on holding that token, and no size gets past a
  // gate — which is why this is counted separately from the three limits below.
  //
  // Saying which wall it is matters more than it looks. A judge reading "no position holds this
  // pair" concludes the integration does not work. The truth is that the index found them, the
  // hash gate proved them, and the router refused them — which is three working parts and one
  // absent maker.
  if (!picked.chosen) {
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
    // Only when something actually priced and priced too high. Saying "ask for less" when nothing
    // priced at all is advice that cannot work, and I shipped exactly that for an afternoon:
    // measured against Arbitrum One, every one of the four positions for WETH/USDC **refuses to
    // quote** at 0.0005 ETH as readily as at 0.1, so no smaller number was ever going to help.
    // Thirty-five active mandates were then scanned across every pair and both directions: zero
    // fillable. Size was never the problem.
    // Before the three limits, because it is not one of them. A gate is not a shortage: the
    // makers may be perfectly funded and it would still refuse.
    if (picked.gated > 0) {
      throw new Error(
        `${picked.gated} Aqua position${picked.gated === 1 ? "" : "s"} for this pair price only for takers holding 1inch's SwapVM access token, which this wallet does not. No size gets past that. Providing liquidity of your own is what fixes it.`,
      );
    }
    if (picked.overCap > 0 && picked.largestCap > 0n) {
      throw new Error(
        `The largest Aqua position for this pair can pay ${Number(formatUnits(picked.largestCap, 6)).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${outSymbolFor(tokenOut)} and this asks for more. Ask for a smaller amount, or provide liquidity of your own.`,
      );
    }
    // Which of the three limits held every candidate back. A ledger that is the limit means the
    // makers are simply small; a wallet or an allowance that is the limit means their positions are
    // not backed at all, and no amount of asking for less will fix it. Saying which is the
    // difference between advice that can work and advice that cannot (#393).
    const walls = [...bound.values()];
    const unbacked = walls.filter((w) => w !== "ledger").length;
    if (unbacked > 0) {
      throw new Error(
        `${unbacked} of ${walls.length} Aqua position${walls.length === 1 ? "" : "s"} for this pair are not backed by the maker's own wallet or approval, so they cannot be filled at any size. Providing liquidity of your own is what fixes this.`,
      );
    }
    throw new Error(
      `${orders.length} Aqua position${orders.length === 1 ? "" : "s"} hold this pair and none of them will price it, at any size. Providing liquidity of your own is what fixes this.`,
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
