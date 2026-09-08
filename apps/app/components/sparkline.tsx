"use client";

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

export function Sparkline({ days, label }: { days: Day[]; label: string }) {
  if (days.length === 0) return null;
  const max = Math.max(...days.map((d) => d.count), 1);
  const { line, area } = path(days, max);
  const busiest = days.reduce((a, b) => (b.count > a.count ? b : a));

  return (
    <figure className="mt-4">
      <figcaption className="flex items-baseline justify-between gap-4">
        <span className="text-[11.5px] text-soft">{label}</span>
        <span className="tabular text-[11px] text-faint">
          busiest {busiest.date} · {busiest.count}
        </span>
      </figcaption>
      <svg
        aria-label={`${label}. ${days.length} days, busiest ${busiest.date} with ${busiest.count}.`}
        className="mt-2 w-full"
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
          className="chart-line"
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
      <div className="mt-1 flex justify-between text-[10.5px] text-faint">
        <span>{days[0]?.date}</span>
        <span>{days[days.length - 1]?.date}</span>
      </div>
    </figure>
  );
}

/** One row per day, zero-filled, so a quiet week reads as quiet rather than as missing. */
export function byDay(timestamps: number[]): Day[] {
  if (timestamps.length === 0) return [];
  const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
  const counts = new Map<string, number>();
  for (const t of timestamps) counts.set(day(t), (counts.get(day(t)) ?? 0) + 1);

  const sorted = [...timestamps].sort((a, b) => a - b);
  const out: Day[] = [];
  const oneDay = 86_400;
  const first = sorted[0] as number;
  const last = sorted[sorted.length - 1] as number;
  for (let t = first; t <= last + 1; t += oneDay) {
    const d = day(t);
    out.push({ date: d, count: counts.get(d) ?? 0 });
    if (out.length > 400) break;
  }
  return out;
}
