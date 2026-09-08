"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { useAccount } from "wagmi";

import { GeneratedAvatar } from "@/components/generated-avatar";
import { Card } from "@/components/kit";
import { byDay, lastDays, Sparkline } from "@/components/sparkline";
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
      <div className="flex flex-wrap items-center justify-between gap-3 py-6">
        <div className="flex items-center gap-3">
          {/* Seeded on the address, so a wallet looks the same on every visit and two
              wallets never look alike. */}
          <GeneratedAvatar name={address ?? "helico"} size={36} />
          <h1 className="font-medium text-[19px] text-ink tracking-tight">
            {isConnected && address ? (
              <>
                Welcome, <span className="font-mono">{short(address)}</span>
              </>
            ) : (
              "Portfolio"
            )}
          </h1>
        </div>
        <span className="text-[12.5px] text-soft">
          {read ? `Read ${read}` : "Arbitrum One"}
        </span>
      </div>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-[12.5px] text-soft">In your account</div>
            <div className="tabular mt-1 font-medium text-[44px] text-ink leading-none tracking-tight">
              {held ? <Amount value={held.total} /> : "—"}
            </div>
            <div className="tabular mt-2.5 font-mono text-[11.5px] text-faint">
              {held
                ? `${usdc(held.idle)} liquid · ${usdc(held.working)} working`
                : factory
                  ? account.isError
                    ? "the chain did not answer"
                    : "reading the account…"
                  : "no account factory deployed yet, so there is nothing to total"}
            </div>
          </div>

          {all.length > 0 ? (
            <div className="flex rounded-full bg-shade p-0.5 text-[11.5px]">
              {RANGES.map((r) => (
                <button
                  aria-pressed={range === r.label}
                  className={cn(
                    "rounded-full px-2.5 py-1 transition-colors",
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
          ) : null}
        </div>

        {days.length > 0 ? (
          <Sparkline axes days={days} label="Aqua movements per day" />
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
