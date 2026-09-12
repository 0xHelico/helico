"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

/**
 * The value chart: a line, a dashed grid, a scale down the left, and a crosshair.
 *
 * **Everything here is geometry.** It is handed a series and draws it; it does not know what the
 * numbers mean, where they came from, or how they were folded. `lib/value-history.ts` owns that.
 *
 * Two decisions in here are about honesty rather than looks, and both were wrong once:
 *
 * The line **steps**. A balance holds its value until something changes it, so sloping from one
 * reading to the next draws a single deposit as a gradual climb through figures the account was
 * never worth.
 *
 * The scale is worked out **before** the plot's width, because its labels decide how wide the
 * gutter has to be. The other way round the gutter is a guess, and the guess that shipped cut the
 * last character off every figure on the axis.
 */

type XY = { x: number; y: number };

export type Point = { timestamp: number; value: number };

export type XYPoint = XY;

/**
 * Exported so the summary's mini chart draws the same geometry as the full one.
 *
 * The stepping is the part that matters: a balance holds its value until something changes it, and
 * a second implementation that sloped would make the small chart disagree with the large one about
 * the same account.
 */
export const linePath = (pts: XY[], step: boolean) =>
  pts
    .map((p, i) =>
      i === 0
        ? `M${p.x},${p.y}`
        : step
          ? `L${p.x},${pts[i - 1]?.y ?? p.y}L${p.x},${p.y}`
          : `L${p.x},${p.y}`,
    )
    .join("");

export function areaPath(pts: XY[], height: number, step: boolean): string {
  const last = pts.at(-1);
  return last
    ? `${linePath(pts, step)}L${last.x},${height}L${pts[0]?.x ?? 0},${height}Z`
    : "";
}

const HEIGHT = 240;
const MARGIN = { top: 16, right: 8, bottom: 28 };
/** The narrowest the scale's gutter goes, before the labels ask for more. */
const AXIS_MIN = 44;
/** Roughly one date every hundred pixels, which is what nine labels across a card comes to. */
const PX_PER_X_LABEL = 100;
const MAX_X_LABELS = 9;
const TOOLTIP_HALF_WIDTH = 70;

type Trend = "up" | "down" | "flat";

/**
 * Green unless the window actually fell.
 *
 * `flat` is green rather than grey on purpose: a balance that has not moved has not lost anything,
 * and a grey line reads as a chart that could not decide. Red is reserved for a real fall, which is
 * the one case worth interrupting somebody over.
 */
const LINE: Record<Trend, string> = {
  up: "#1DA66A",
  flat: "#1DA66A",
  down: "#E5484D",
};

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * The axis in the reader's own clock, day before month, and to the hour when the window is short
 * enough for the hour to be the thing that differs.
 *
 * **A date on its own made the short windows unreadable.** 1D drew nine labels across twenty-four
 * hours and wrote the same date under four of them; moving the crosshair changed nothing a reader
 * could see, because the value holds between events and the label held too. The hour is what tells
 * two points of one day apart.
 *
 * Local rather than UTC, which is a change from the port this came from. A date is the same fact
 * in any zone give or take a day, so UTC cost nothing; an hour is not. `14:00` shown to somebody
 * in Jakarta for an event they watched happen at 21:00 is simply wrong, and reading the date from
 * a different clock than the hour is worse still: `30 Sep 23:00` local is `1 Oct` in UTC, and the
 * label would contradict itself.
 *
 * The order stays fixed at day-then-month rather than deferring to the locale. `toLocaleDateString`
 * puts the month first in some places and the day first in others, so an axis built on it reads
 * differently depending on who opens the page, and the design matches itself for nobody.
 */
const pad = (n: number) => String(n).padStart(2, "0");
const date = (d: Date) => `${d.getDate()} ${MONTHS[d.getMonth()]}`;
const clock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/**
 * Which of those a tick gets, chosen from how much time the whole line covers.
 *
 * The thresholds are about what repeats. Under two days every label would carry the same one or
 * two dates, so the date goes to the tooltip and the axis keeps the hour. Past ten days the hour
 * is noise: the points are days apart and the date already separates them. Past a year even the
 * day is more precision than the axis can place.
 */
export function labeller(points: Point[]): (ts: number) => string {
  const first = points.at(0)?.timestamp ?? 0;
  const last = points.at(-1)?.timestamp ?? 0;
  const span = last - first;
  if (span <= 2 * DAY) {
    return (ts) => clock(new Date(ts));
  }
  if (span <= 10 * DAY) {
    return (ts) => {
      const d = new Date(ts);
      return `${date(d)} ${clock(d)}`;
    };
  }
  if (span <= 400 * DAY) {
    return (ts) => date(new Date(ts));
  }
  return (ts) => {
    const d = new Date(ts);
    return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  };
}

/**
 * The tooltip always carries the hour, whatever the axis decided.
 *
 * It is the one place a reader can ask what a particular point is, and on a balance that holds its
 * value for days the timestamp is the only part that changes as the crosshair moves. A tooltip
 * reading the same figure and the same date at both ends of a flat run looks like a chart that has
 * stopped responding.
 */
export const tooltipLabel = (ts: number) => {
  const d = new Date(ts);
  return `${date(d)} ${d.getFullYear()}, ${clock(d)}`;
};

/** Round a step size to a nice value (1/2/2.5/5 × 10^k) for axis ticks. */
function niceTicks(min: number, max: number, count = 5): number[] {
  if (min === max) {
    return [min];
  }
  const rough = (max - min) / (count - 1);
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = ([1, 2, 2.5, 5, 10].find((b) => rough / pow <= b) ?? 10) * pow;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) {
    ticks.push(+v.toFixed(6));
  }
  return ticks;
}

/**
 * The fewest decimals that still tell the ticks apart.
 *
 * Fixed precision fails at both ends, and both failures shipped. Two decimals put `$0.50` on every
 * tick of the live account, whose whole earning is sixty-five millionths of a dollar; four put four
 * digits of noise on a ninety-dollar one. So it is derived: try two, and add a digit until no two
 * neighbouring ticks print the same thing.
 */
function decimalsFor(ticks: number[]): number {
  for (let d = 2; d < 8; d++) {
    const printed = ticks.map((t) => t.toFixed(d));
    if (new Set(printed).size === printed.length) {
      return d;
    }
  }
  return 8;
}

export function PriceChart({
  points,
  trend = "flat",
  /** How a figure reads on the axis and in the tooltip, at the precision the scale worked out. */
  format,
  /** True for a series that holds its value between readings, which every balance does. */
  step = false,
}: {
  points: Point[];
  trend?: Trend;
  format: (value: number, decimals: number) => string;
  step?: boolean;
}) {
  const id = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) {
      return;
    }
    const ro = new ResizeObserver(([e]) => {
      if (e) {
        setWidth(e.contentRect.width);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;

  const scale = useMemo(() => {
    if (points.length < 2) {
      return { ticks: [] as number[], min: 0, span: 1 };
    }
    const values = points.map((p) => p.value);
    let low = Math.min(...values);
    let high = Math.max(...values);
    if (low === high) {
      // A flat series still gets symmetric room around the line, so it reads as a measurement
      // rather than as a chart that failed to draw.
      low -= 0.06;
      high += 0.06;
    }
    return { ticks: niceTicks(low, high, 7), min: low, span: high - low };
  }, [points]);

  const { ticks, min, span } = scale;
  const decimals = decimalsFor(ticks);
  const labels = ticks.map((t) => format(t, decimals));
  // Measured from the labels rather than assumed: roughly 6.2px per character at 11px in this
  // face, plus the 10px the text is held off the plot by.
  const axis = Math.max(
    AXIS_MIN,
    12 + Math.max(0, ...labels.map((l) => l.length)) * 6.2,
  );
  const plotW = Math.max(0, width - axis - MARGIN.right);

  const pts = useMemo(() => {
    if (points.length < 2 || plotW <= 0) {
      return [] as XY[];
    }
    // Not `step`: the prop of that name is the geometry, and shadowing it here is how a stepped
    // line quietly becomes a sloped one.
    const dx = plotW / (points.length - 1);
    return points.map((p, i) => ({
      x: +(axis + i * dx).toFixed(2),
      y: +(MARGIN.top + (1 - (p.value - min) / span) * plotH).toFixed(2),
    }));
  }, [points, plotW, plotH, min, span, axis]);

  const stamp = useMemo(() => labeller(points), [points]);

  const xTickIdx = useMemo(() => {
    if (pts.length === 0) {
      return [] as number[];
    }
    const count = Math.max(
      2,
      Math.min(MAX_X_LABELS, Math.floor(plotW / PX_PER_X_LABEL)),
    );
    return [
      ...new Set(
        Array.from({ length: count }, (_, i) =>
          Math.round((i * (pts.length - 1)) / (count - 1)),
        ),
      ),
    ];
  }, [pts.length, plotW]);

  const onMove = (e: React.PointerEvent) => {
    const el = containerRef.current;
    if (pts.length === 0 || !el) {
      return;
    }
    const x = e.clientX - el.getBoundingClientRect().left - axis;
    setHover(
      Math.max(
        0,
        Math.min(pts.length - 1, Math.round((x / plotW) * (pts.length - 1))),
      ),
    );
  };

  const h = hover !== null && pts[hover] ? hover : null;
  const hovered = h === null ? null : pts[h];
  const hoveredPoint = h === null ? null : points[h];

  return (
    <div
      className="relative w-full overflow-hidden"
      onPointerLeave={() => setHover(null)}
      onPointerMove={onMove}
      ref={containerRef}
      style={{ height: HEIGHT }}
    >
      {pts.length > 0 ? (
        <svg
          aria-hidden
          className="block max-w-full"
          height={HEIGHT}
          width={width}
        >
          <defs>
            <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
              <stop stopColor={LINE[trend]} stopOpacity="0.16" />
              <stop offset="1" stopColor={LINE[trend]} stopOpacity="0" />
            </linearGradient>
          </defs>
          {ticks.map((t, i) => {
            const y = MARGIN.top + (1 - (t - min) / span) * plotH;
            return (
              <g key={t}>
                <line
                  stroke="#111827"
                  strokeDasharray="3 4"
                  strokeOpacity="0.08"
                  x1={axis}
                  x2={axis + plotW}
                  y1={y}
                  y2={y}
                />
                {/* Down the left, right-aligned against the plot's edge, so the numbers read as a
                    column and the line starts where the scale stops. */}
                <text
                  className="tabular"
                  fill="#83878b"
                  fontSize="11"
                  textAnchor="end"
                  x={axis - 10}
                  y={y + 4}
                >
                  {labels[i]}
                </text>
              </g>
            );
          })}
          {xTickIdx.map((i, n) => (
            <text
              fill="#83878b"
              fontSize="11"
              key={points[i]?.timestamp ?? i}
              textAnchor={
                n === 0 ? "start" : n === xTickIdx.length - 1 ? "end" : "middle"
              }
              x={pts[i]?.x}
              y={HEIGHT - 8}
            >
              {stamp(points[i]?.timestamp ?? 0)}
            </text>
          ))}
          <path
            className="chart-area"
            d={areaPath(pts, MARGIN.top + plotH, step)}
            fill={`url(#${id})`}
          />
          <path
            className="chart-line"
            d={linePath(pts, step)}
            fill="none"
            pathLength={1}
            stroke={LINE[trend]}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
          />
          {hovered ? (
            <g>
              <line
                stroke="#6f7377"
                strokeDasharray="3 3"
                x1={hovered.x}
                x2={hovered.x}
                y1={MARGIN.top}
                y2={MARGIN.top + plotH}
              />
              <circle
                cx={hovered.x}
                cy={hovered.y}
                fill={LINE[trend]}
                r="4.5"
                stroke="#fff"
                strokeWidth="2"
              />
            </g>
          ) : null}
        </svg>
      ) : null}
      {hovered && hoveredPoint ? (
        <div
          className="-translate-x-1/2 pointer-events-none absolute top-3 z-10 rounded-lg border border-line bg-white px-3 py-1.5 shadow-sm"
          style={{
            left: Math.max(
              TOOLTIP_HALF_WIDTH,
              Math.min(width - TOOLTIP_HALF_WIDTH, hovered.x),
            ),
          }}
        >
          <div className="tabular font-medium text-sm">
            {format(hoveredPoint.value, decimals)}
          </div>
          <div className="whitespace-nowrap text-[11px] text-soft">
            {tooltipLabel(hoveredPoint.timestamp)}
          </div>
        </div>
      ) : null}
    </div>
  );
}
