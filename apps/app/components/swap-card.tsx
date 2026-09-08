"use client";

import { NATIVE, planSwap, type SwapStep } from "@helico/plugin-uniswap";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowRight, Check, Loader2 } from "lucide-react";
import { erc20Abi, formatUnits, type Hex } from "viem";
import {
  useAccount,
  usePublicClient,
  useSendTransaction,
  useSwitchChain,
} from "wagmi";
import { Button } from "@/components/ui/button";
import { explorerTx, SLIPPAGE_BPS } from "@/lib/chain";
import type { Intent } from "@/lib/intent";
import { shortfall } from "@/lib/intent";

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
      if (intent.tokenIn.address === NATIVE) {
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
        {balance.data !== undefined ? (
          <>
            <dt>You hold</dt>
            <dd className={short ? "text-destructive" : undefined}>
              {formatUnits(balance.data, intent.tokenIn.decimals)}{" "}
              {intent.tokenIn.symbol}
            </dd>
          </>
        ) : null}
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

            {short ? (
              <p className="mt-3 text-destructive text-xs">
                This wallet is {formatUnits(short, intent.tokenIn.decimals)}{" "}
                {intent.tokenIn.symbol} short. Nothing is sent — the swap would
                revert and cost you the gas to find out.
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
