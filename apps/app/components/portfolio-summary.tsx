"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { formatUnits } from "viem";
import { useAccount } from "wagmi";

import { GeneratedAvatar } from "@/components/generated-avatar";
import { Card } from "@/components/kit";
import { byDay, Sparkline } from "@/components/sparkline";
import { totals, useAccountState } from "@/hooks/use-account-state";
import { configuredFactory } from "@/lib/account";
import { readMovements } from "@/lib/mandates";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const usdc = (v: bigint) =>
  Number(formatUnits(v, 6)).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/**
 * The portfolio in one line, at the top of the page about limits.
 *
 * It answers "what have I got" so the page below can be entirely about "what may it do" — the
 * two were competing for the same screen, and the one a visitor has an answer to today is this
 * one. Everything here links through rather than repeating the full page.
 *
 * The value is absent rather than zero until the account has actually been read. Zero is a
 * measurement — an account read and found empty — and a dash is the absence of one. Saying zero
 * before reading would be a claim about an account nobody has looked at.
 */
export function PortfolioSummary() {
  const { address, isConnected } = useAccount();
  const factory = configuredFactory();
  const account = useAccountState();
  const held = totals(account.data);

  const moves = useQuery({
    enabled: Boolean(address),
    queryKey: ["movements", address],
    queryFn: () => readMovements(address as string),
  });

  const days = moves.data ? byDay(moves.data.timestamps) : [];

  return (
    <Card className="mt-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <GeneratedAvatar name={address ?? "helico"} size={32} />
          <div className="min-w-0">
            <p className="font-medium text-[14px] text-ink leading-none">
              {isConnected && address ? (
                <>
                  Welcome, <span className="font-mono">{short(address)}</span>
                </>
              ) : (
                "No wallet connected"
              )}
            </p>
            <p className="mt-1.5 text-[11.5px] text-soft">In your account</p>
          </div>
        </div>
        <Link
          className="flex shrink-0 items-center gap-1.5 text-[12.5px] text-soft hover:text-ink"
          href="/portfolio"
        >
          View full portfolio
          <ArrowRight className="size-3.5" />
        </Link>
      </div>

      <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="tabular font-medium text-[30px] text-ink tracking-tight">
            {held ? (
              <>
                {usdc(held.total).split(".")[0] as string}
                <span className="text-faint">
                  .{usdc(held.total).split(".")[1] ?? "00"}
                </span>
                <span className="ml-1.5 font-normal text-[13px] text-soft">
                  USDC
                </span>
              </>
            ) : (
              "—"
            )}
          </div>
          <p className="mt-1 text-[11px] text-faint">
            {held
              ? `${usdc(held.idle)} liquid · ${usdc(held.working)} working`
              : factory
                ? account.isError
                  ? "The chain did not answer."
                  : "Reading the account…"
                : "No account factory deployed yet, so there is nothing to total."}
          </p>
        </div>
        {days.length > 0 ? (
          <div className="w-full sm:max-w-[300px]">
            <Sparkline days={days} label="Aqua movements per day" />
          </div>
        ) : null}
      </div>
    </Card>
  );
}
