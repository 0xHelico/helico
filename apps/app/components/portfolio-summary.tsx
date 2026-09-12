"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { formatUnits } from "viem";
import { usePublicClient } from "wagmi";

import { ChangeWindows } from "@/components/change-windows";
import { Card, Loading } from "@/components/kit";
import { ValueSpark } from "@/components/sparkline";
import { CHAIN_ID, totals, useAccountState } from "@/hooks/use-account-state";
import { configuredFactory } from "@/lib/account";
import { readAccountActivity } from "@/lib/activity";
import { change, sample, valueSeries } from "@/lib/value-history";

/** Dollars, sign outside the symbol, so a fall reads `-$0.02` rather than `$-0.02`. */
const money = (v: number, decimals = 2) =>
  `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;

const usdc = (v: bigint) => money(Number(formatUnits(v, 6)));

/**
 * The portfolio in one line, at the top of the page about limits.
 *
 * It answers "what have I got" so the page below can be entirely about "what may it do" — the two
 * were competing for the same screen, and the one a visitor has an answer to today is this one.
 * Everything here links through rather than repeating the full page.
 *
 * **One row, and no second copy of what the page already says.** It used to open with an avatar and
 * "Welcome, 0x3B4f…85F5" over "In your account", then the figure, then the liquid-and-working
 * split: four facts stacked where the page wanted one. The address is in the sidebar, the greeting
 * is on the portfolio page, and the split is in Holdings. What is left is the total, which way it
 * went, and a line of it.
 *
 * The value is absent rather than zero until the account has actually been read. Zero is a
 * measurement — an account read and found empty — and a dash is the absence of one. Saying zero
 * before reading would be a claim about an account nobody has looked at.
 */
export function PortfolioSummary() {
  const factory = configuredFactory();
  const account = useAccountState();
  const held = totals(account.data);
  const client = usePublicClient({ chainId: CHAIN_ID });
  const open =
    account.data && account.data.kind === "open"
      ? (account.data.address as `0x${string}`)
      : null;

  const own = useQuery({
    enabled: Boolean(open && client),
    queryKey: ["account-activity", open],
    queryFn: () =>
      readAccountActivity(
        client as NonNullable<typeof client>,
        open as `0x${string}`,
      ),
    retry: false,
    staleTime: 15_000,
  });

  // After mount only: every window here is measured from `Date.now()`, which the server and the
  // browser do not agree on.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const full = useMemo(
    () => (mounted ? valueSeries(own.data ?? [], held) : []),
    [mounted, own.data, held],
  );
  // The spark shows the month, which is the widest of the three windows reported beside it.
  const month = useMemo(() => sample(full, 30), [full]);
  const trend = change(month, 4).trend;

  const pending = account.isPending && Boolean(factory);

  return (
    <Card className="mt-6">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
        <div className="min-w-0">
          <p className="text-[11.5px] text-soft">Total portfolio value</p>
          <div className="numeric tabular mt-0.5 font-medium text-[28px] text-ink leading-none tracking-tight">
            {pending ? (
              <Loading className="h-7 w-28" />
            ) : held ? (
              <Amount value={held.total} />
            ) : (
              <span className="font-sans text-[13px] text-soft">
                {factory
                  ? account.isError
                    ? "The chain did not answer."
                    : "Reading the account…"
                  : "No account factory deployed yet."}
              </span>
            )}
          </div>
        </div>

        {/* Each window's own change, from its own start. Hidden while there is nothing to compare,
            rather than three zeroes standing in for an unread account. */}
        {/* Not while the log is still loading: one live point makes every window start at
            nothing, and a 24H change then reads as the whole balance arriving today. */}
        {held && !own.isPending && full.length > 1 ? (
          <ChangeWindows series={full} />
        ) : null}

        {/* A line only once there are two dated readings to draw between. One point is a dot, and
            a dot stretched across a box is a shape rather than a reading. */}
        {month.length > 1 ? (
          <div className="h-9 min-w-[140px] flex-1">
            <ValueSpark
              label="What this account has been worth over the last month"
              points={month}
              trend={trend}
            />
          </div>
        ) : (
          <div className="flex-1" />
        )}

        <Link
          className="flex shrink-0 items-center gap-0.5 text-[12.5px] text-soft hover:text-ink"
          href="/portfolio"
        >
          View portfolio
          <ChevronRight className="size-3.5" />
        </Link>
      </div>
    </Card>
  );
}

/** The cents in a lighter ink, so the figure reads at a glance and stays exact on inspection. */
function Amount({ value }: { value: bigint }) {
  const [whole, cents = "00"] = usdc(value).split(".");
  return (
    <>
      {whole}
      <span className="text-faint">.{cents}</span>
    </>
  );
}
