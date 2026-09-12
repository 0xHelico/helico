"use client";

import { cn } from "@/lib/utils";
import { change, sample, type ValuePoint } from "@/lib/value-history";

/** The three near windows. Anything wider is what the range buttons on the chart are for. */
const WINDOWS = [
  { label: "24H", days: 1 },
  { label: "1W", days: 7 },
  { label: "1M", days: 30 },
] as const;

const INK: Record<"up" | "down" | "flat", string> = {
  up: "text-[#1DA66A]",
  down: "text-[#E5484D]",
  flat: "text-soft",
};

/** Dollars, sign outside the symbol, so a fall reads `-$0.02` rather than `$-0.02`. */
const money = (v: number, decimals: number) =>
  `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;

/**
 * What changed over each of the near windows, from the same series the chart draws.
 *
 * **One implementation, two cards.** The summary on the limits page and the hero on the portfolio
 * page both answer "which way did it go", and two versions of that arithmetic would eventually
 * disagree about the same account in the same session — which is the reason the mini chart takes
 * its geometry from the full one rather than redrawing it.
 *
 * Each window is measured from its own start, not from the widest one: `1W` is what happened in
 * the last seven days, which is a different question from a thirtieth of the month.
 */
export function ChangeWindows({
  series,
  className,
}: {
  series: ValuePoint[];
  className?: string;
}) {
  return (
    <div className={cn("flex gap-7", className)} data-testid="change-windows">
      {WINDOWS.map((w) => (
        <Window days={w.days} key={w.label} label={w.label} series={series} />
      ))}
    </div>
  );
}

/**
 * One window: its name, and what changed inside it.
 *
 * **A percentage needs something to be a percentage of.** An account funded inside the window
 * started at nothing, and every gain from nothing is infinite — so that case reports the amount
 * instead, which is the same fact without the division. Reporting `0.00%` there, which is what a
 * fixed layout invites, would be a number nobody computed.
 *
 * Four decimals, because the thing being measured is small: a market pays a fraction of a cent a
 * day on half a dollar, and rounded to cents the whole earning disappears into a zero.
 */
function Window({
  label,
  days,
  series,
}: {
  label: string;
  days: number;
  series: ValuePoint[];
}) {
  const moved = change(sample(series, days), 4);
  const sign = moved.absolute > 0 ? "+" : moved.absolute < 0 ? "−" : "";
  return (
    <div>
      <p className="text-[11px] text-faint">{label}</p>
      <p
        className={cn("tabular mt-1 font-mono text-[12.5px]", INK[moved.trend])}
      >
        {moved.trend === "flat"
          ? "0.00%"
          : moved.percent === null
            ? `${sign}${money(Math.abs(moved.absolute), 4)}`
            : `${sign}${Math.abs(moved.percent).toFixed(2)}%`}
      </p>
    </div>
  );
}
