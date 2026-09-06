"use client";

import { planSwap, type SwapStep } from "@helico/plugin-uniswap";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowRight, Check, Loader2 } from "lucide-react";
import { formatUnits, type Hex } from "viem";
import {
  useAccount,
  usePublicClient,
  useSendTransaction,
  useSwitchChain,
} from "wagmi";
import { Button } from "@/components/ui/button";
import { explorerTx, SLIPPAGE_BPS } from "@/lib/chain";
import type { Intent } from "@/lib/intent";

/**
 * The words for each transaction. The plugin returns what a step is; what a person reads about
 * it belongs here, next to the rest of the copy.
 */
const label = (step: SwapStep, intent: Intent) =>
  ({
    "approve-token": `Approve ${intent.tokenIn.symbol} for Permit2`,
    "approve-permit2": `Allow the router to spend your ${intent.tokenIn.symbol}`,
    swap: `Swap ${intent.amountIn} ${intent.tokenIn.symbol} for ${intent.tokenOut.symbol}`,
  })[step.kind];

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
      return planSwap(publicClient, {
        account: address,
        tokenIn: intent.tokenIn.address,
        tokenOut: intent.tokenOut.address,
        amountIn: BigInt(intent.amountInWei),
        slippageBps: SLIPPAGE_BPS,
      });
    },
  });

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

  return (
    <div className="mt-3 rounded-xl border p-4">
      <div className="flex items-center gap-3 font-medium text-base">
        <span>
          {intent.amountIn} {intent.tokenIn.symbol}
        </span>
        <ArrowRight className="size-4 text-muted-foreground" />
        <span>{intent.tokenOut.symbol}</span>
      </div>

      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-muted-foreground text-xs">
        <dt>Network</dt>
        <dd>{intent.chain}</dd>
        <dt>Giving</dt>
        <dd>
          {intent.tokenIn.name} · {intent.amountInWei} of its smallest unit
        </dd>
        <dt>Receiving</dt>
        <dd>{intent.tokenOut.name}</dd>
        {plan.data ? (
          <>
            <dt>Pool</dt>
            <dd>{plan.data.pool.key.fee / 10_000}% fee tier, no hook</dd>
            <dt>You get</dt>
            <dd>
              about {formatUnits(plan.data.amountOut, intent.tokenOut.decimals)}{" "}
              {intent.tokenOut.symbol}
            </dd>
            <dt>At worst</dt>
            <dd>
              {formatUnits(plan.data.minAmountOut, intent.tokenOut.decimals)}{" "}
              {intent.tokenOut.symbol}, or it does not fill (
              {SLIPPAGE_BPS / 100}% slippage)
            </dd>
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

            {run.isSuccess ? (
              <p className="mt-3 text-xs">
                Filled. Your wallet holds the {intent.tokenOut.symbol}; Helico
                never held it.
              </p>
            ) : (
              <Button
                className="mt-3"
                disabled={run.isPending}
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
