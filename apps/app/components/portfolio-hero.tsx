"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { useAccount, usePublicClient } from "wagmi";

import { GeneratedAvatar } from "@/components/generated-avatar";
import { Card, Loading } from "@/components/kit";
import { PriceChart } from "@/components/price-chart";
import { windowDays } from "@/components/sparkline";
import { CHAIN_ID, totals, useAccountState } from "@/hooks/use-account-state";
import { configuredFactory } from "@/lib/account";
import { readAccountActivity } from "@/lib/activity";
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

  const client = usePublicClient({ chainId: CHAIN_ID });
  const held0 = account.data;
  const open =
    held0 && held0.kind === "open" ? (held0.address as `0x${string}`) : null;

  const moves = useQuery({
    enabled: Boolean(address),
    queryKey: ["movements", address],
    queryFn: () => readMovements(address as string),
  });
  // The account's own events, which is what this chart plots most of the time.
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

  /**
   * **Both kinds of move, in one series.**
   *
   * This plotted Aqua movements alone, and those are fills against a shipped mandate. So on an
   * account that had been armed, funded, and had capital supplied to Morpho by the enclave, it drew
   * a flat line at zero: true about the narrow question it was asking, and read by everyone as the
   * product not working. Adding a sentence explaining the zero was the wrong fix, because the page
   * had something to draw and was not drawing it.
   *
   * The account's own events carry a timestamp only when the backend served them, since a log does
   * not have one and fetching a header per block from a browser is the cost `/api/activity` exists
   * to avoid. Undated events are dropped from the series rather than stacked on today, which would
   * invent a spike.
   */
  const stamps = [
    ...(moves.data?.timestamps ?? []),
    ...(own.data ?? [])
      .map((e) => e.at)
      .filter((at): at is number => typeof at === "number"),
  ];
  const span = RANGES.find((r) => r.label === range) ?? RANGES[1];
  // The window, not the span of the data: two events two days apart should read as a quiet month
  // with two busy days, which is what it is, rather than as a chart with two points in it.
  const days = windowDays(stamps, span.days ?? null);

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

        {/* A wallet with no movements still gets the line, flat at zero. That is the reading
            rather than a placeholder — nothing moved on each of those days — and the card keeps
            its shape instead of collapsing to a number and a gap. */}
        {mounted ? (
          <div className="mt-4">
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-[11.5px] text-soft">Moves per day</span>
            </div>
            {/* **A flat line has to say why it is flat.** Keeping the axis rather than collapsing
                to a gap is right, and on its own it reads as "no data" — which is what a reader
                said it read as, on a day the account had just supplied half a dollar to Morpho.
                Zero is the true answer to the question this series asks, and the question is
                narrower than the page: `supplyIdle` moves money into a lending market and is not
                an Aqua movement. Only a fill against a shipped position is. */}
            {stamps.length === 0 && !own.isPending && !moves.isPending ? (
              <p className="mt-1 text-[11px] text-faint leading-relaxed">
                Nothing has moved yet. What the agent does, and what a taker
                fills against a position you have shipped, both land here.
              </p>
            ) : null}
            {/* `windowDays` already walks the whole range, so the empty case is a series of
                zeroes rather than an empty array. The fallback that used to be here existed
                because `byDay` returned nothing at all when there was nothing to draw. */}
            <div className="mt-2">
              <PriceChart
                points={days.map((d) => ({
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
