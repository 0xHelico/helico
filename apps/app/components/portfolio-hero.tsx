"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { useAccount } from "wagmi";

import { GeneratedAvatar } from "@/components/generated-avatar";
import { Card } from "@/components/kit";
import { PriceChart } from "@/components/price-chart";
import { byDay, lastDays, zeroDays } from "@/components/sparkline";
import { totals, useAccountState } from "@/hooks/use-account-state";
import { configuredFactory } from "@/lib/account";
import { readMovements } from "@/lib/mandates";
import { cn } from "@/lib/utils";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Always two decimals here. The cents are set in a lighter ink, and a missing pair looks broken. */
const usdc = (v: bigint) =>
  Number(formatUnits(v, 6)).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const RANGES = [
  { label: "7D", days: 7 },
  { label: "30D", days: 30 },
  { label: "90D", days: 90 },
  { label: "1Y", days: 365 },
  { label: "ALL", days: null },
] as const;

type RangeLabel = (typeof RANGES)[number]["label"];

/**
 * The one number, and who it belongs to.
 *
 * A dash rather than `0.00` while there is nothing to read. Zero is a measurement — it says an
 * account was read and found empty — and the two look identical unless the line underneath says
 * which one this is.
 *
 * The ranges are days, not prices. A value-over-time line would need a price feed and a history
 * nobody is keeping; movements per day is a thing that happened, and it is the series we have.
 */
export function PortfolioHero() {
  const { address, isConnected } = useAccount();
  const factory = configuredFactory();
  const account = useAccountState();
  const [range, setRange] = useState<RangeLabel>("30D");

  const moves = useQuery({
    enabled: Boolean(address),
    queryKey: ["movements", address],
    queryFn: () => readMovements(address as string),
  });
  const all = moves.data ? byDay(moves.data.timestamps) : [];
  const span = RANGES.find((r) => r.label === range) ?? RANGES[1];
  const days = lastDays(all, span.days);

  // Rendered after mount only. The server has no clock the browser agrees with to the second,
  // and a timestamp is the one piece of a page guaranteed to differ between the two.
  // `zeroDays` reads today's date, which the server and the browser need not agree on, so the
  // chart waits for the client rather than risking a hydration mismatch over a tick label.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [read, setRead] = useState<string | null>(null);
  useEffect(() => {
    setRead(
      account.dataUpdatedAt
        ? new Date(account.dataUpdatedAt).toLocaleString(undefined, {
            dateStyle: "long",
            timeStyle: "medium",
          })
        : null,
    );
  }, [account.dataUpdatedAt]);

  const held = totals(account.data);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 py-8">
        <div className="flex items-center gap-2.5">
          {/* Seeded on the address, so a wallet looks the same on every visit and two
              wallets never look alike. */}
          <GeneratedAvatar name={address ?? "helico"} size={36} />
          <h1 className="font-medium text-ink text-xl tracking-tight">
            {isConnected && address ? (
              <>
                Welcome, <span className="font-mono">{short(address)}</span>
              </>
            ) : (
              "Portfolio"
            )}
          </h1>
        </div>
        {/* No "Read" in front of it. The line is a timestamp and reads as one; the word only
            took space from the thing somebody is actually checking. */}
        <span className="text-[15px] text-soft">{read ?? "Arbitrum One"}</span>
      </div>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            {/* No label above the figure. The page is the portfolio and the line under the number
                already says which part is liquid, so a caption here only pushes the one thing
                somebody came to read further down. */}
            <div className="tabular font-medium text-4xl text-ink tracking-tight">
              {held ? <Amount value={held.total} /> : "—"}
            </div>
            <div className="tabular mt-3 font-mono text-soft text-xs">
              {held
                ? `${usdc(held.idle)} liquid · ${usdc(held.working)} working`
                : factory
                  ? account.isError
                    ? "the chain did not answer"
                    : "reading the account…"
                  : "no account factory deployed yet, so there is nothing to total"}
            </div>
          </div>

          {/* Always here. It used to appear only once a wallet had movements, so an empty
              account got a number and a hole where the reference has a control and a flat line. */}
          <div className="flex shrink-0 rounded-xl bg-shade p-1">
            {RANGES.map((r) => (
              <button
                aria-pressed={range === r.label}
                className={cn(
                  "rounded-lg px-3 py-1.5 font-medium text-xs transition-colors",
                  range === r.label
                    ? "bg-white text-ink shadow-sm"
                    : "text-soft hover:text-ink",
                )}
                key={r.label}
                onClick={() => setRange(r.label)}
                type="button"
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {/* A wallet with no movements still gets the line, flat at zero. That is the reading
            rather than a placeholder — nothing moved on each of those days — and the card keeps
            its shape instead of collapsing to a number and a gap. */}
        {mounted ? (
          <div className="mt-4">
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-[11.5px] text-soft">
                Aqua movements per day
              </span>
            </div>
            <div className="mt-2">
              <PriceChart
                points={(days.length > 0
                  ? days
                  : zeroDays(span.days ?? 30)
                ).map((d) => ({
                  timestamp: Date.parse(`${d.date}T00:00:00Z`),
                  value: d.count,
                }))}
              />
            </div>
          </div>
        ) : null}
      </Card>
    </>
  );
}

/** The cents in a lighter ink, so the figure reads at a glance and stays exact on inspection. */
function Amount({ value }: { value: bigint }) {
  const [whole, cents = "00"] = usdc(value).split(".");
  return (
    <>
      {whole}
      <span className="text-faint">.{cents}</span>
      <span className="ml-2 font-normal text-[15px] text-soft">USDC</span>
    </>
  );
}
