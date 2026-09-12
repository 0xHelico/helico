"use client";

import { useId } from "react";

import { areaPath, linePath } from "@/components/price-chart";

/**
 * Movements per day, as one line.
 *
 * Change over time, one series — so a line, no legend (the title names it), and no number on
 * every point. The single hue is Helico's accent, checked against this surface with the
 * palette validator rather than chosen: inside the lightness band, above the chroma floor, and
 * over 3:1 against white.
 *
 * The y-axis starts at zero and is not drawn. A count of events has a true zero, so a truncated
 * one would exaggerate every rise; and the reader's question here is "when was it busy", which
 * shape answers without a scale.
 */

const W = 480;
const H = 92;
const PAD = 6;

export type Day = { date: string; count: number };

function path(days: Day[], max: number): { line: string; area: string } {
  const n = days.length;
  const x = (i: number) => (n === 1 ? W / 2 : (i / (n - 1)) * W);
  // Padding at the top only: a day with nothing must sit *on* the baseline, or the gap
  // under it reads as a small value that is not there.
  const y = (v: number) => PAD + (1 - v / max) * (H - PAD);
  const line = days
    .map((d, i) => `${i ? "L" : "M"}${x(i)},${y(d.count)}`)
    .join(" ");
  return { line, area: `${line} L${x(n - 1)},${H} L${x(0)},${H} Z` };
}

/**
 * Where to draw a rule, as a share of the plot's height.
 *
 * The same expression as `y` above rather than a second one that agrees with it today: a
 * gridline that sits a pixel off its own value is worse than no gridline, because it is read as
 * the value it is nearest.
 */
const pct = (v: number, max: number) =>
  ((PAD + (1 - v / max) * (H - PAD)) / H) * 100;

/**
 * A scale to rule and label, and the top of it.
 *
 * Three even gaps ending on a round number, rather than thirds of whatever the busiest day
 * happened to be — dividing 7 into thirds gives 0, 2, 5, 7, which are four numbers with no
 * pattern between them and read as arbitrary because they are.
 *
 * The steps are whole numbers throughout. These are counts of events, so a gridline at 2.5 would
 * be a line at a value the data cannot take.
 */
function niceScale(max: number): { top: number; ticks: number[] } {
  // Aim for four gaps, then let the top be the first multiple of the step that covers the data.
  // Fixing the number of gaps instead pushes the top far above the busiest day — a 10 charted to
  // 15 leaves a third of the plot empty and makes a busy week look like a quiet one.
  const step = Math.max(1, niceStep(max / 4));
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = top; v >= 0; v -= step) ticks.push(v);
  return { top, ticks };
}

/** The next 1, 2 or 5 times a power of ten at or above `n`, which is what a reader expects. */
function niceStep(n: number): number {
  const mag = 10 ** Math.floor(Math.log10(n));
  return ([1, 2, 5, 10].map((m) => m * mag).find((s) => s >= n) ??
    10 * mag) as number;
}

/** A handful of dates spread across the range, first and last always among them. */
function dateLabels(days: Day[], want: number): string[] {
  if (days.length <= want) return days.map((d) => d.date);
  const step = (days.length - 1) / (want - 1);
  return Array.from(
    { length: want },
    (_, i) => (days[Math.round(i * step)] as Day).date,
  );
}

export function Sparkline({
  days,
  label,
  axes = false,
}: {
  days: Day[];
  label: string;
  /** Rules, a scale and dates along the bottom. Off by default: the summary has no room. */
  axes?: boolean;
}) {
  if (days.length === 0) return null;
  const busiest = days.reduce((a, b) => (b.count > a.count ? b : a));
  // With rules drawn, the plot is scaled to the top of the scale rather than to the busiest day,
  // or the top gridline would sit above the line it is meant to measure.
  const scale = niceScale(Math.max(busiest.count, 1));
  const max = axes ? scale.top : Math.max(busiest.count, 1);
  const { line, area } = path(days, max);
  const ticks = axes ? scale.ticks : [];

  const plot = (
    <>
      <svg
        aria-label={`${label}. ${days.length} days, busiest ${busiest.date} with ${busiest.count}.`}
        className="chart-reveal block w-full"
        height={H}
        preserveAspectRatio="none"
        role="img"
        viewBox={`0 0 ${W} ${H}`}
      >
        <title>{label}</title>
        <defs>
          <linearGradient id="spark-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#695cff" stopOpacity="0.16" />
            <stop offset="100%" stopColor="#695cff" stopOpacity="0" />
          </linearGradient>
        </defs>
        {/*
          The axis, drawn because zero sits on it. Without a rule, a run of quiet days is a line
          hugging the bottom edge at one pixel and reads as no data rather than as no movement —
          which are opposite facts.
        */}
        <line
          stroke="#e9e9e7"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
          x1={0}
          x2={W}
          y1={H - 0.5}
          y2={H - 0.5}
        />
        <path className="chart-area" d={area} fill="url(#spark-fill)" />
        <path
          d={line}
          fill="none"
          pathLength={1}
          stroke="#695cff"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </>
  );

  // The rules and the scale are HTML, not SVG. This chart is drawn with
  // `preserveAspectRatio="none"` so the line fills whatever width it is given, and anything with
  // a shape of its own inside that viewBox — a glyph, a dash pattern — comes out stretched by
  // however wide the card happens to be.
  return (
    <figure className="mt-4">
      <figcaption className="flex items-baseline justify-between gap-4">
        <span className="text-[11.5px] text-soft">{label}</span>
        <span className="tabular text-[11px] text-faint">
          busiest {busiest.date} · {busiest.count}
        </span>
      </figcaption>

      {axes ? (
        <>
          {/* The scale reads down the left edge and the plot sits on the card's own white. A
              tinted box behind it made the chart a panel inside a panel, which is one border more
              than the reference draws. */}
          <div className="relative mt-3 pl-9">
            {ticks.map((v) => (
              <div key={v}>
                <span
                  className="tabular -translate-y-1/2 absolute left-0 w-7 text-right text-[11px] text-faint leading-none"
                  style={{ top: `${pct(v, max)}%` }}
                >
                  {v}
                </span>
                <span
                  className="absolute right-0 left-9 border-t border-dashed border-ink/10"
                  style={{ top: `${pct(v, max)}%` }}
                />
              </div>
            ))}
            {plot}
          </div>
          <div className="tabular mt-2 flex justify-between pl-9 text-[11px] text-faint">
            {dateLabels(days, 5).map((d) => (
              <span key={d}>{d}</span>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="mt-2">{plot}</div>
          <div className="tabular mt-1 flex justify-between text-[11px] text-faint">
            <span>{days[0]?.date}</span>
            <span>{days[days.length - 1]?.date}</span>
          </div>
        </>
      )}
    </figure>
  );
}

/** The last `n` days of a series, or all of it. One row is one day, so this is a date range. */
/**
 * `n` days ending today, all zero.
 *
 * A wallet with no movements has no series at all — `byDay([])` is empty — so the chart used to
 * vanish and take the range switcher with it. Zero on every day is not invented data: it is the
 * true reading, and the axis label already says what is being counted. The alternative was a card
 * with a number and a hole under it.
 */
export function zeroDays(n: number): Day[] {
  const out: Day[] = [];
  const ONE_DAY = 86_400_000;
  const midnight = Date.parse(
    `${new Date().toISOString().slice(0, 10)}T00:00:00Z`,
  );
  for (let i = n - 1; i >= 0; i--) {
    out.push({
      date: new Date(midnight - i * ONE_DAY).toISOString().slice(0, 10),
      count: 0,
    });
  }
  return out;
}

/**
 * The last `n` whole days ending today, each carrying whatever fell on it.
 *
 * **Why this exists beside `byDay`.** `byDay` spans the first event to the last, so two events two
 * days apart draw two points. On a card whose axis is labelled thirty days that reads as a chart
 * with almost no data rather than as a quiet month with two busy days, which is what it is. This
 * walks the window instead, so every day in the range is a point and the quiet ones are zero.
 *
 * `n === null` means "all of it", and there the span of the data is the right window, so `byDay`
 * answers that case unchanged.
 */
export function windowDays(timestamps: number[], n: number | null): Day[] {
  if (n === null) return byDay(timestamps);
  const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
  const counts = new Map<string, number>();
  for (const t of timestamps) counts.set(day(t), (counts.get(day(t)) ?? 0) + 1);
  const ONE_DAY = 86_400_000;
  const midnight = Date.parse(
    `${new Date().toISOString().slice(0, 10)}T00:00:00Z`,
  );
  const out: Day[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const date = new Date(midnight - i * ONE_DAY).toISOString().slice(0, 10);
    out.push({ date, count: counts.get(date) ?? 0 });
  }
  return out;
}

export function lastDays(days: Day[], n: number | null): Day[] {
  return n === null || days.length <= n ? days : days.slice(-n);
}

/**
 * One row per day, zero-filled, so a quiet week reads as quiet rather than as missing.
 *
 * Walks whole days, not seconds. The first version stepped 86,400 from the first timestamp,
 * which silently dropped the last day whenever the range opened later in the day than it closed
 * — and the test could not see it, because every fixture timestamp was pinned to noon, which
 * makes the bug impossible to express.
 */
export function byDay(timestamps: number[]): Day[] {
  if (timestamps.length === 0) return [];
  const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
  const counts = new Map<string, number>();
  for (const t of timestamps) counts.set(day(t), (counts.get(day(t)) ?? 0) + 1);

  const sorted = [...timestamps].sort((a, b) => a - b);
  // Midnight UTC of the first and last day, so the walk is over dates rather than over the
  // clock times that happen to bracket them.
  const start = Date.parse(`${day(sorted[0] as number)}T00:00:00Z`);
  const end = Date.parse(
    `${day(sorted[sorted.length - 1] as number)}T00:00:00Z`,
  );

  const out: Day[] = [];
  const ONE_DAY = 86_400_000;
  for (let ms = start; ms <= end; ms += ONE_DAY) {
    const d = new Date(ms).toISOString().slice(0, 10);
    out.push({ date: d, count: counts.get(d) ?? 0 });
    // Aqua's oldest movement is months back. Without a cap, one stale timestamp draws thousands
    // of points into 480 pixels and takes the page with it.
    if (out.length >= 400) break;
  }
  return out;
}

/**
 * A value series at summary size: a stepped line, a fill under it, and nothing else.
 *
 * **Not the sparkline above it.** That one plots a count of movements per day and keeps a rule at
 * zero, because a run of quiet days hugging the bottom edge reads as no data rather than as no
 * movement. This plots money, which has no such floor to explain, and it is the same geometry the
 * full chart draws — `linePath` and `areaPath` come from `price-chart.tsx` rather than being
 * written again, so the small chart cannot disagree with the large one about the same account.
 */
export function ValueSpark({
  points,
  trend,
  label,
}: {
  points: { timestamp: number; value: number }[];
  trend: "up" | "down" | "flat";
  label: string;
}) {
  const id = useId();
  if (points.length < 2) {
    return null;
  }
  const w = 220;
  const h = 34;
  const values = points.map((p) => p.value);
  let low = Math.min(...values);
  let high = Math.max(...values);
  if (low === high) {
    // A flat series sits in the middle rather than on an edge, where it would read as a boundary
    // of the box instead of as a reading.
    low -= 0.06;
    high += 0.06;
  }
  const span = high - low;
  const step = w / (points.length - 1);
  const pts = values.map((v, i) => ({
    x: +(i * step).toFixed(2),
    y: +(2 + (1 - (v - low) / span) * (h - 4)).toFixed(2),
  }));
  const colour = trend === "down" ? "#E5484D" : "#1DA66A";

  return (
    <svg
      aria-label={label}
      className="block h-full w-full"
      height={h}
      preserveAspectRatio="none"
      role="img"
      viewBox={`0 0 ${w} ${h}`}
      width={w}
    >
      <title>{label}</title>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop stopColor={colour} stopOpacity="0.18" />
          <stop offset="1" stopColor={colour} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath(pts, h, true)} fill={`url(#${id})`} />
      <path
        d={linePath(pts, true)}
        fill="none"
        stroke={colour}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
