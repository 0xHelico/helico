"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { formatUnits } from "viem";
import { useAccount, usePublicClient } from "wagmi";

import { GeneratedAvatar } from "@/components/generated-avatar";
import { Card, Loading } from "@/components/kit";
import { PriceChart } from "@/components/price-chart";
import { CHAIN_ID, totals, useAccountState } from "@/hooks/use-account-state";
import { configuredFactory } from "@/lib/account";
import { readAccountActivity } from "@/lib/activity";
import { cn } from "@/lib/utils";
import { change, sample, valueSeries } from "@/lib/value-history";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * Dollars, with the sign outside the symbol.
 *
 * `-$0.02` rather than `$-0.02`, which is what putting the sign inside gives and reads as a typo.
 * The negative half of the scale is not hypothetical: a flat series opens the axis symmetrically
 * around the line, so an empty account's ticks run below zero.
 */
const money = (v: number, decimals = 2) =>
  `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;

/** The same figure from base units, which is what the account is read in. */
const usdc = (v: bigint) => money(Number(formatUnits(v, 6)));

const RANGES = [
  { label: "1D", days: 1 },
  { label: "1W", days: 7 },
  { label: "1M", days: 30 },
  { label: "3M", days: 90 },
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
 * **The line is what the account was worth, and it is measured rather than modelled.** This used to
 * plot movements per day, because the comment here said a value line "would need a price feed and a
 * history nobody is keeping". Half of that was wrong. There is no price feed to need: every balance
 * on this page is USDC, so the total is already in dollars. And the history is kept, by the chain:
 * the account's own events plus its USDC transfers account for every unit it has ever held, and
 * logs are the one thing a pruned endpoint still answers. `lib/value-history.ts` does the fold and
 * says why each half is there.
 *
 * Movements per day is not lost. `portfolio-summary.tsx` still carries it, which is the right place
 * for it: it answers how busy the account has been, and this card answers what is in it.
 */
export function PortfolioHero() {
  const { address, isConnected } = useAccount();
  const factory = configuredFactory();
  const account = useAccountState();
  const [range, setRange] = useState<RangeLabel>("1D");

  const client = usePublicClient({ chainId: CHAIN_ID });
  const held0 = account.data;
  const open =
    held0 && held0.kind === "open" ? (held0.address as `0x${string}`) : null;

  // The account's own events and its transfers, which are the two halves of the value line.
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

  const held = totals(account.data);
  const span = RANGES.find((r) => r.label === range) ?? RANGES[1];
  // Rendered after mount only, and this is why: the series ends at `Date.now()` and the window
  // starts a number of days before it, so the server and the browser would disagree on both. A
  // timestamp is the one piece of a page guaranteed to differ between the two.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const series = useMemo(
    () =>
      mounted
        ? sample(valueSeries(own.data ?? [], held), span.days ?? null)
        : [],
    [mounted, own.data, held, span.days],
  );
  // Only for the colour. Green unless the window actually fell, which is what the chart's own
  // `LINE` table says; the figure itself is not printed beside the total any more.
  const moved = change(series);
  // **Events with no dates are a different state from no events at all.** The first cannot be
  // plotted and must say so; the second is a flat line at zero, which is the truth about an
  // account that has never held anything.
  const undated =
    (own.data?.length ?? 0) > 0 &&
    !own.data?.some((e) => typeof e.at === "number");

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
                Welcome,{" "}
                {/* Already truncated, so a line break inside it splits an ellipsis from its
                    tail — "0xc11e…" over "0D12" on any narrow screen. */}
                <span className="whitespace-nowrap font-mono">
                  {short(address)}
                </span>
              </>
            ) : (
              "Portfolio"
            )}
          </h1>
        </div>
        {/* No "Read" in front of it. The line is a timestamp and reads as one; the word only
            took space from the thing somebody is actually checking. */}
        <span className="text-[17px] text-soft">{read ?? "Arbitrum One"}</span>
      </div>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          {/* The one figure, and nothing above or below it. The split between liquid and working
              lives in the Holdings card, and a second line of it here only pushed the thing
              somebody came to read further down. */}
          <div className="numeric tabular font-medium text-[44px] text-ink leading-none tracking-tight">
            {account.isPending ? (
              <Loading className="h-10 w-40" />
            ) : held ? (
              <Amount value={held.total} />
            ) : (
              <span className="font-sans text-soft text-base">
                {factory
                  ? account.isError
                    ? "the chain did not answer"
                    : "reading the account…"
                  : "no account factory deployed yet, so there is nothing to total"}
              </span>
            )}
          </div>

          {/* Always here. It used to appear only once a wallet had movements, so an empty
              account got a number and a hole where the design has a control and a flat line. */}
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

        {/* An account with nothing in it still gets the line, flat at zero, with the scale opened
            symmetrically around it. That is the reading rather than a placeholder: an account that
            has never held anything has always been worth nothing. */}
        {mounted ? (
          <div className="mt-2">
            <PriceChart
              format={money}
              points={series}
              step
              trend={moved.trend}
            />
            {/* **A flat line is a claim, when the readings have no dates.** The fallback that
                reads the chain directly has no timestamps to give: `eth_getLogs` does not carry
                one and fetching a header per block from a browser is the cost `/api/activity`
                exists to avoid. The fold then has the live figure alone, and drawing that across
                the window says the account has always been worth it.

                An account with no history at all is the opposite case and needs no caption: it
                has always been worth nothing, and the flat line at zero is the reading. */}
            {undated ? (
              <p className="text-[11px] text-faint leading-relaxed">
                Read from the chain directly, which carries no dates, so only
                today's figure is placed. The line fills in once the backend has
                the history.
              </p>
            ) : null}
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
    </>
  );
}
