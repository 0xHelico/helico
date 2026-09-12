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
import { change, valueSeries, windowed } from "@/lib/value-history";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Always two decimals here. The cents are set in a lighter ink, and a missing pair looks broken. */
const usdc = (v: bigint) =>
  Number(formatUnits(v, 6)).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/**
 * The axis and the tooltip, in dollars, at whatever precision the series needs.
 *
 * Cents are right for an account holding tens of dollars and useless for the one this was built
 * against: a market pays a fraction of a cent a day on half a dollar, and rounded to cents the
 * whole earning disappears. Four decimals everywhere is the other failure, and it is the one that
 * shipped first: `$80.0000` on a ninety-dollar account, four digits of noise per tick.
 */
const money = (v: number, decimals: 2 | 4) =>
  `$${v.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;

/** Cents unless the whole line lives inside a dollar, where cents would round it flat. */
const precisionFor = (points: { value: number }[]): 2 | 4 =>
  Math.max(0, ...points.map((p) => p.value)) < 1 ? 4 : 2;

const CHANGE_INK: Record<"up" | "down" | "flat", string> = {
  up: "text-[#1DA66A]",
  down: "text-[#E5484D]",
  flat: "text-soft",
};

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
  const [range, setRange] = useState<RangeLabel>("30D");

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
        ? windowed(valueSeries(own.data ?? [], held), span.days ?? null)
        : [],
    [mounted, own.data, held, span.days],
  );
  // The precision first: it decides both how a figure is printed and how small a difference still
  // counts as one, which have to be the same number or the label argues with the line.
  const decimals = precisionFor(series);
  const dollars = (v: number) => money(v, decimals);
  const moved = change(series, decimals);

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
          <div>
            {/* No label above the figure. The page is the portfolio and the line under the number
                already says which part is liquid, so a caption here only pushes the one thing
                somebody came to read further down. */}
            <div className="tabular font-medium text-4xl text-ink tracking-tight">
              {account.isPending ? (
                <Loading className="h-9 w-40" />
              ) : held ? (
                <Amount value={held.total} />
              ) : (
                "nothing yet"
              )}
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

        {/* An account with nothing in it still gets the line, flat at zero. That is the reading
            rather than a placeholder, and the card keeps its shape instead of collapsing to a
            number and a gap. */}
        {mounted ? (
          <div className="mt-4">
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-[11.5px] text-soft">
                What this account has been worth
              </span>
              {/* The change over the window, beside the window's own buttons. A total on its own
                  says nothing about which way it got there, which is the question a range control
                  invites somebody to ask. */}
              {series.length > 1 ? (
                <span
                  className={cn(
                    "tabular font-mono text-[11.5px]",
                    CHANGE_INK[moved.trend],
                  )}
                >
                  {moved.trend === "flat"
                    ? "unchanged"
                    : `${moved.absolute > 0 ? "+" : "−"}${dollars(Math.abs(moved.absolute))}${
                        moved.percent === null
                          ? ""
                          : ` (${moved.percent > 0 ? "+" : "−"}${Math.abs(moved.percent).toFixed(2)}%)`
                      }`}
                </span>
              ) : null}
            </div>
            {/* **A line with one point is not a line.** The fold needs a dated event, and the
                fallback that reads the chain directly has no dates to give: `eth_getLogs` does not
                carry a timestamp and fetching a header per block from a browser is the cost
                `/api/activity` exists to avoid. So say which of the two this is, rather than
                drawing a flat line that would claim the account has always been worth this. */}
            {series.length < 2 && !own.isPending && !account.isPending ? (
              <p className="mt-1 text-[11px] text-faint leading-relaxed">
                Nothing dated to plot yet. Money arriving, and every move the
                agent makes with it, both land on this line.
              </p>
            ) : null}
            <div className="mt-2">
              <PriceChart
                format={dollars}
                points={series}
                step
                trend={moved.trend}
              />
            </div>
            {/* Said plainly, because the alternative was drawing it. Interest still inside a market
                cannot be read at a past block — the endpoint keeps about an hour of state — so the
                line carries principal and ends at the live reading. */}
            <p className="mt-2 text-[11px] text-faint leading-relaxed">
              Built from this account's own logs: every USDC transfer in or out,
              and every move the agent made. The last point is what the chain
              says right now, so anything a market has paid and nobody has taken
              out yet is the step at the end.
            </p>
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
