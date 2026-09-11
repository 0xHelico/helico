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
import { planOneInchSwap } from "@/lib/oneinch-swap";
import { unitsForDollars } from "@/lib/usd";

/**
 * The words for each transaction. The plugin returns what a step is; what a person reads about
 * it belongs here, next to the rest of the copy.
 */
/** Either planner's step. Uniswap has a Permit2 approval that Aqua does not; Aqua has a wrap. */
type Step = {
  kind: AquaStep["kind"] | "approve-permit2";
  transaction: AquaStep["transaction"];
};

/** What the person asked for, in the words they used. A dollar sentence has no token figure until
 *  the feed has answered, and printing one before it does would be a number with no source. */
const asked = (intent: Intent, sized: bigint | null) =>
  intent.amountUsd
    ? sized === null
      ? `$${intent.amountUsd} of ${intent.tokenIn.symbol}`
      : `${amountShort(sized, intent.tokenIn.decimals)} ${intent.tokenIn.symbol} ($${intent.amountUsd})`
    : `${intent.amountIn} ${intent.tokenIn.symbol}`;

const label = (step: Step, intent: Intent, sized: bigint | null) =>
  ({
    // Aqua positions hold WETH and the router pulls with `safeTransferFrom`, so ETH is wrapped
    // first. Named as its own step because it is the wallet's own ether moving, and a person
    // signing two transactions should be told which one is which.
    wrap: `Wrap ${asked(intent, sized)} into WETH`,
    "approve-token": `Allow the router to spend your ${intent.tokenIn.symbol === "ETH" ? "WETH" : intent.tokenIn.symbol}`,
    "approve-permit2": `Allow Permit2 to spend your ${intent.tokenIn.symbol}`,
    swap: `Swap ${asked(intent, sized)} for ${intent.tokenOut.symbol}`,
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
function rate(
  intent: Intent,
  out: bigint,
  sized: bigint | null,
): string | null {
  // From the resolved amount, not the sentence: a dollar sentence leaves `amountIn` empty, and
  // reading it there returned NaN and quietly printed a dash where the price goes.
  const given =
    sized === null
      ? Number(intent.amountIn)
      : Number(formatUnits(sized, intent.tokenIn.decimals));
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

  /**
   * The amount to swap, in the input token's own units.
   *
   * A sentence that named dollars arrives without one: the backend reports the dollars and does
   * not divide, because it has no price and a model asked to convert produces a figure nobody can
   * check. So the number a person is about to sign is read here, from Chainlink, by the wallet
   * that will sign it — and it is refused rather than guessed when there is no feed or the feed is
   * stale.
   */
  const sized = useQuery({
    enabled: Boolean(publicClient),
    queryKey: [
      "sized",
      intent.chainId,
      intent.tokenIn.address,
      intent.amountInWei,
      intent.amountUsd,
    ],
    // A price goes stale, and this one decides an amount rather than describing it.
    staleTime: 20_000,
    retry: false,
    queryFn: async () => {
      if (!intent.amountUsd) return amountOf(intent.amountInWei);
      return await unitsForDollars(
        publicClient as NonNullable<typeof publicClient>,
        intent.tokenIn.address,
        intent.tokenIn.decimals,
        intent.amountUsd,
      );
    },
  });

  const plan = useQuery({
    queryKey: [
      "swap-plan",
      intent.chainId,
      intent.tokenIn.address,
      intent.tokenOut.address,
      intent.amountInWei,
      intent.amountUsd,
      address,
    ],
    // Waits for the amount as well as the wallet: a dollar sentence has no units until the feed
    // has answered, and planning against `null` is a crash rather than a refusal.
    enabled: Boolean(
      publicClient && address && onRightChain && sized.data !== undefined,
    ),
    // A quote is a price, and a price goes stale. Refusing to reuse one for long is the
    // difference between the number shown and the number filled.
    staleTime: 20_000,
    retry: false,
    queryFn: async () => {
      if (!(publicClient && address)) {
        throw new Error("No client");
      }
      // Aqua first, 1inch's aggregation route when Aqua cannot fill.
      //
      // Aqua's liquidity is not thin, it is **absent**. Thirty-five active mandates were scanned
      // across every pair and both directions and **none** would price at any size — for
      // WETH/USDC, four positions refuse a quote at 0.0005 ETH as readily as at 0.1. So an
      // Aqua-only swap is a swap that does not work for anybody who has not shipped a position of
      // their own, which the front door cannot assume.
      //
      // What Aqua keeps is everything it was doing: `provide` ships through it, the contracts are
      // ours, and the moment a position exists this path takes it — the fallback only runs when it
      // cannot.
      //
      // **The fallback was Uniswap v4 until 11 September, for one reason: the aggregation API
      // needs a key and we had none**, while the v4 Quoter is an on-chain call. We have a key now,
      // and Uniswap has not been a submitted track since 7 September (#125), so the product's most
      // visible action was ending at a protocol we do not submit while the partner we do submit sat
      // behind a refusal. `@helico/plugin-uniswap` is not deleted and its tests stay green; it is
      // simply not in this path. (#401)
      //
      // The route is named in the card either way. A swap that quietly changes venue is the kind
      // of thing that reads as a claim.
      let aquaWhy: string | null = null;
      try {
        const viaAqua = await planAquaSwap(publicClient, {
          account: address,
          tokenIn: intent.tokenIn.address,
          tokenOut: intent.tokenOut.address,
          amountIn: amountIn as bigint,
          slippageBps: SLIPPAGE_BPS,
        });
        if (viaAqua) {
          return {
            amountOut: viaAqua.amountOut,
            minAmountOut: viaAqua.minAmountOut,
            steps: viaAqua.steps as Step[],
            route: `1inch Aqua · ${viaAqua.valid} of ${viaAqua.considered} live orders quotable`,
            note: null as string | null,
          };
        }
      } catch (e) {
        aquaWhy = e instanceof Error ? e.message : String(e);
      }

      // 1inch's own aggregation, reached through `/api/1inch/…` — a route handler on our server,
      // which is the only place the key exists. No `NEXT_PUBLIC_` here or anywhere: that prefix
      // inlines a value into the client bundle, and a bundled key is a public key.
      const viaOneInch = await planOneInchSwap(publicClient, {
        account: address,
        amountIn: amountIn as bigint,
        chainId: intent.chainId,
        slippageBps: SLIPPAGE_BPS,
        tokenIn: intent.tokenIn.address,
        tokenOut: intent.tokenOut.address,
      });
      return {
        amountOut: viaOneInch.amountOut,
        minAmountOut: viaOneInch.minAmountOut,
        steps: viaOneInch.steps as Step[],
        route: `1inch aggregation · every venue it can reach`,
        note: aquaWhy,
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

  const amountIn = sized.data ?? null;
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
          throw new Error(`${label(step, intent, amountIn)} failed on chain`);
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
        {/* The headline, through the same helper as the steps. Reading `amountIn` here printed a
            bare " ETH" for a dollar sentence, which is the one figure on this card a person looks
            at before signing. */}
        <Side amount={asked(intent, amountIn)} symbol={intent.tokenIn.symbol} />
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
              {rate(intent, plan.data.amountOut, amountIn) ?? "—"}{" "}
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

      {/* Why it is not on Aqua, when it is not. Shown rather than swallowed: a swap that changes
          venue without saying so is the kind of thing that reads as a claim, and the reason is
          the interesting part — Aqua found the positions and the router refused them. */}
      {plan.data?.note ? (
        <p className="mt-2 text-muted-foreground text-xs">{plan.data.note}</p>
      ) : null}

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
                    {label(step, intent, amountIn)}
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
