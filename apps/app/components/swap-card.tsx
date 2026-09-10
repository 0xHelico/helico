"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowDown, Check, Loader2 } from "lucide-react";
import { erc20Abi, formatUnits, type Hex, zeroAddress } from "viem";
import {
  useAccount,
  usePublicClient,
  useSendTransaction,
  useSwitchChain,
} from "wagmi";
import { ChainMark, TokenMark } from "@/components/token-mark";
import { Button } from "@/components/ui/button";
import { type AquaStep, planAquaSwap } from "@/lib/aqua-swap";
import { explorerTx, SLIPPAGE_BPS } from "@/lib/chain";
import { amountFloor, amountShort } from "@/lib/format";
import type { Intent } from "@/lib/intent";
import { shortfall } from "@/lib/intent";

/**
 * The words for each transaction. The plugin returns what a step is; what a person reads about
 * it belongs here, next to the rest of the copy.
 */
const label = (step: AquaStep, intent: Intent) =>
  ({
    // Aqua positions hold WETH and the router pulls with `safeTransferFrom`, so ETH is wrapped
    // first. Named as its own step because it is the wallet's own ether moving, and a person
    // signing two transactions should be told which one is which.
    wrap: `Wrap ${intent.amountIn} ETH into WETH`,
    "approve-token": `Allow 1inch's router to spend your ${intent.tokenIn.symbol === "ETH" ? "WETH" : intent.tokenIn.symbol}`,
    swap: `Swap ${intent.amountIn} ${intent.tokenIn.symbol} for ${intent.tokenOut.symbol}`,
  })[step.kind];

/**
 * The amount, or null if the stored intent does not hold one.
 *
 * `intent` is cast out of a stored message without validation, and `BigInt()` throws on anything
 * that is not an integer string. On the render path that is not a failed query with a message
 * beside it — it is an uncaught exception, and with no error boundary under `app/` the whole page
 * goes blank. Low reachability today; a blank page is not a proportionate consequence.
 */
function amountOf(wei: string): bigint | null {
  try {
    return BigInt(wei);
  } catch {
    return null;
  }
}

/** One side of the swap: the amount at reading size, its mark beside it. */
function Side({ amount, symbol }: { amount: string; symbol: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="font-medium text-[19px] text-foreground tracking-tight">
        {amount}
      </span>
      <TokenMark size={30} symbol={symbol} />
    </div>
  );
}

/** The price, as one number a person can hold in their head. */
function rate(intent: Intent, out: bigint): string | null {
  const given = Number(intent.amountIn);
  if (!Number.isFinite(given) || given <= 0) {
    return null;
  }
  const got = Number(formatUnits(out, intent.tokenOut.decimals));
  return (got / given).toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export function SwapCard({ intent }: { intent: Intent }) {
  const { address, isConnected, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: intent.chainId });
  const { switchChain, isPending: switching } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();
  const onRightChain = chainId === intent.chainId;

  const plan = useQuery({
    queryKey: [
      "swap-plan",
      intent.chainId,
      intent.tokenIn.address,
      intent.tokenOut.address,
      intent.amountInWei,
      address,
    ],
    enabled: Boolean(publicClient && address && onRightChain),
    // A quote is a price, and a price goes stale. Refusing to reuse one for long is the
    // difference between the number shown and the number filled.
    staleTime: 20_000,
    retry: false,
    queryFn: async () => {
      if (!(publicClient && address)) {
        throw new Error("No client");
      }
      // Aqua, and only Aqua. The Uniswap fallback was dropped on 10 September at Ghoza's call.
      //
      // Uniswap is a competitor's protocol on screen in a submission whose tracks are Chainlink,
      // 1inch and The Graph, and the swap was the one part of the product where neither 1inch nor
      // The Graph carried any weight. Through Aqua both do: the fill is 1inch's SwapVM, and the
      // candidates exist only because the index can list them — `_balances` is private and four
      // levels deep, and no event parameter is indexed.
      //
      // **What this costs, stated rather than discovered.** Live Aqua liquidity is thin and
      // pair-specific: measured on Arbitrum One, of eleven valid live orders none would price
      // USDC into WETH. So until a maker position exists for a pair, this card answers "nothing
      // to fill against" rather than routing elsewhere. That is the honest answer for a product
      // whose swap is an Aqua swap.
      const viaAqua = await planAquaSwap(publicClient, {
        account: address,
        tokenIn: intent.tokenIn.address,
        tokenOut: intent.tokenOut.address,
        amountIn: BigInt(intent.amountInWei),
        slippageBps: SLIPPAGE_BPS,
      });
      // `planAquaSwap` names which wall it hit, so this no longer flattens three different facts
      // into the one that happens to be false on Arbitrum One.
      if (!viaAqua) {
        throw new Error("Nothing to fill against right now.");
      }
      return {
        amountOut: viaAqua.amountOut,
        minAmountOut: viaAqua.minAmountOut,
        steps: viaAqua.steps,
        route: `1inch Aqua · ${viaAqua.valid} of ${viaAqua.considered} live orders quotable`,
      };
    },
  });

  // What the wallet actually holds of the input token. This is the reason the app asks for a
  // wallet before it will talk: a quote against a balance that cannot cover it is a number that
  // wastes somebody's gas to find out.
  const balance = useQuery({
    queryKey: ["balance", intent.chainId, intent.tokenIn.address, address],
    enabled: Boolean(publicClient && address && onRightChain),
    staleTime: 15_000,
    retry: false,
    queryFn: async (): Promise<bigint> => {
      if (!(publicClient && address)) {
        throw new Error("No client");
      }
      if (intent.tokenIn.address === zeroAddress) {
        return publicClient.getBalance({ address });
      }
      return publicClient.readContract({
        abi: erc20Abi,
        address: intent.tokenIn.address,
        args: [address],
        functionName: "balanceOf",
      });
    },
  });

  const amountIn = amountOf(intent.amountInWei);
  const short = amountIn === null ? null : shortfall(balance.data, amountIn);

  const run = useMutation({
    mutationFn: async () => {
      const steps = plan.data?.steps;
      if (!(steps && publicClient)) {
        throw new Error("Nothing to send");
      }
      const sent: Hex[] = [];
      for (const step of steps) {
        const hash = await sendTransactionAsync({
          to: step.transaction.to,
          data: step.transaction.data,
          value: step.transaction.value,
        });
        sent.push(hash);
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") {
          throw new Error(`${label(step, intent)} failed on chain`);
        }
      }
      return sent;
    },
  });

  const sentCount = run.data?.length ?? 0;

  if (amountIn === null) {
    return (
      <p className="mt-3 rounded-xl border p-4 text-destructive text-xs">
        This swap was stored with an amount that cannot be read, so nothing is
        offered for it.
      </p>
    );
  }

  return (
    // A confirm sheet, not a banner. The chat column is `max-w-4xl` and nothing on this card is
    // that wide, so at full width the marks sit a hand's width from the amounts they belong to and
    // every detail row ends in several hundred pixels of nothing.
    <div className="mt-3 w-full max-w-md rounded-xl border p-4">
      {/* Two amounts stacked, each with its own mark, and nothing else at this size. The card used
          to lead with a row of symbols and then bury the number a person actually decides on
          seven rows down, between the token's full name and the size of its smallest unit. */}
      <div className="space-y-2">
        <Side
          amount={`${intent.amountIn} ${intent.tokenIn.symbol}`}
          symbol={intent.tokenIn.symbol}
        />
        <ArrowDown className="size-4 text-muted-foreground" />
        <Side
          amount={
            plan.data
              ? `${amountShort(plan.data.amountOut, intent.tokenOut.decimals)} ${intent.tokenOut.symbol}`
              : intent.tokenOut.symbol
          }
          symbol={intent.tokenOut.symbol}
        />
      </div>

      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-5 gap-y-1.5 border-t pt-3 text-muted-foreground text-xs">
        {plan.data ? (
          <>
            <dt>Rate</dt>
            <dd>
              1 {intent.tokenIn.symbol} ={" "}
              {rate(intent, plan.data.amountOut) ?? "—"}{" "}
              {intent.tokenOut.symbol}
            </dd>
            {/* Floored rather than rounded: this is the number the swap guarantees, and rounding
                it up would promise four ten-thousandths the fill does not owe. */}
            <dt>At worst</dt>
            <dd>
              {amountFloor(plan.data.minAmountOut, intent.tokenOut.decimals)}{" "}
              {intent.tokenOut.symbol}, or it does not fill (
              {SLIPPAGE_BPS / 100}% slippage)
            </dd>
          </>
        ) : null}
        <dt>Network</dt>
        <dd className="flex items-center gap-1.5">
          <ChainMark chainId={intent.chainId} size={14} />
          {intent.chain}
        </dd>
        {plan.data ? (
          <>
            <dt>Route</dt>
            <dd>{plan.data.route}</dd>
          </>
        ) : null}
      </dl>

      <div className="mt-4 border-t pt-3">
        {!isConnected ? (
          <p className="text-muted-foreground text-xs">
            Connect a wallet to price this and sign it.
          </p>
        ) : !onRightChain ? (
          <Button
            disabled={switching}
            onClick={() => switchChain({ chainId: intent.chainId })}
            size="sm"
          >
            Switch to {intent.chain}
          </Button>
        ) : plan.isPending ? (
          <p className="flex items-center gap-2 text-muted-foreground text-xs">
            <Loader2 className="size-3 animate-spin" /> Reading the pool and
            your allowances…
          </p>
        ) : plan.error ? (
          <p className="text-destructive text-xs">{plan.error.message}</p>
        ) : plan.data ? (
          <>
            <ol className="space-y-1 text-xs">
              {plan.data.steps.map((step, i) => (
                <li
                  className="flex items-center gap-2"
                  key={`${step.kind}-${step.transaction.to}`}
                >
                  {i < sentCount ? (
                    <Check className="size-3 text-muted-foreground" />
                  ) : run.isPending && i === sentCount ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <span className="size-3 text-center text-muted-foreground">
                      {i + 1}
                    </span>
                  )}
                  <span
                    className={
                      i < sentCount ? "text-muted-foreground" : undefined
                    }
                  >
                    {label(step, intent)}
                  </span>
                  {run.data?.[i] ? (
                    <a
                      className="underline underline-offset-2"
                      href={explorerTx(intent.chainId, run.data[i])}
                      rel="noreferrer"
                      target="_blank"
                    >
                      receipt
                    </a>
                  ) : null}
                </li>
              ))}
            </ol>

            {short ? (
              <p className="mt-3 text-destructive text-xs">
                This wallet is {amountShort(short, intent.tokenIn.decimals)}{" "}
                {intent.tokenIn.symbol} short. Nothing is sent, because the swap
                would revert and cost you the gas to find out.
              </p>
            ) : null}

            {run.isSuccess ? (
              <p className="mt-3 text-xs">
                Filled. Your wallet holds the {intent.tokenOut.symbol}; Helico
                never held it.
              </p>
            ) : (
              <Button
                className="mt-3"
                disabled={run.isPending || short !== null}
                onClick={() => run.mutate()}
                size="sm"
              >
                {run.isPending
                  ? `Signing ${sentCount + 1} of ${plan.data.steps.length}…`
                  : plan.data.steps.length > 1
                    ? `Sign ${plan.data.steps.length} transactions`
                    : "Sign and swap"}
              </Button>
            )}

            {run.error ? (
              <p className="mt-2 text-destructive text-xs">
                {run.error.message.split("\n")[0]}
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
