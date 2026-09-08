"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useAccount } from "wagmi";

import { Glyph } from "@/components/glyph";
import { Card } from "@/components/kit";
import { byDay, Sparkline } from "@/components/sparkline";
import { configuredFactory } from "@/lib/account";
import { readMovements } from "@/lib/mandates";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * The portfolio in one line, at the top of the page about limits.
 *
 * It answers "what have I got" so the page below can be entirely about "what may it do" — the
 * two were competing for the same screen, and the one a visitor has an answer to today is this
 * one. Everything here links through rather than repeating the full page.
 *
 * The value is deliberately absent rather than zero. Nothing of ours is deployed, so there is no
 * balance to read, and `$0.00` is a claim about an account that does not exist.
 */
export function PortfolioSummary() {
  const { address, isConnected } = useAccount();
  const factory = configuredFactory();

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
          <Glyph name="bank" size={30} />
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
            {factory ? "—" : "—"}
          </div>
          <p className="mt-1 text-[11px] text-faint">
            {factory
              ? "Reading the account…"
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
