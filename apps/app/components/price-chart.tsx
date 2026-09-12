"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

/**
 * The detail chart, ported from the implementation this app's surfaces are matched against.
 *
 * Kept faithful where it is about drawing — the margins, the nice-stepped ticks, the gradient
 * under the line, the crosshair and the tooltip — and changed only where the series differs.
 * That reference plots money; this plots how many times a maker's mandates moved on a day, so the
 * scale is a count and a `$` in front of it would be a unit this page cannot source.
 */

type XY = { x: number; y: number };

export type Point = { timestamp: number; value: number };

const linePath = (pts: XY[], step = false) =>
  pts
    .map((p, i) =>
      i === 0
        ? `M${p.x},${p.y}`
        : // **A balance holds until something changes it.** Sloping from one reading to the next
          // draws a deposit as a gradual climb across the days either side of it, and the account
          // was never worth any of the figures on that slope. Horizontal to the new moment, then
          // vertical to the new value, is the shape the events actually describe.
          step
          ? `L${p.x},${pts[i - 1]?.y ?? p.y}L${p.x},${p.y}`
          : `L${p.x},${p.y}`,
    )
    .join("");

function areaPath(pts: XY[], height: number, step = false): string {
  const last = pts.at(-1);
  return last
    ? `${linePath(pts, step)}L${last.x},${height}L${pts[0]?.x ?? 0},${height}Z`
    : "";
}

const HEIGHT = 240;
const MARGIN = { top: 16, right: 48, bottom: 28, left: 8 };
/**
 * The gutter the tick labels are written into, measured from the labels rather than assumed.
 *
 * 48px was enough for a count and not for money: `$80.0000` was drawn to the edge and the last
 * character was cut off, on every tick, which looked like a rendering fault rather than a margin.
 * Roughly 6.2px per character at 11px in this face, plus the 10px the text is offset by.
 */
const gutter = (labels: string[]) =>
  Math.max(
    MARGIN.right,
    12 + Math.max(0, ...labels.map((l) => l.length)) * 6.2,
  );
const PX_PER_X_LABEL = 110;
const TOOLTIP_HALF_WIDTH = 70;

/**
 * Helico's own line where the series has no direction, and the reference's red-or-green where it
 * has one.
 *
 * A count of movements is not good or bad, so a green line climbing through it would claim
 * something the data does not say. Money is the other case: a total that went up went up, and the
 * colour is the fastest way to read that. `flat` is its own answer rather than a rounding of `up`.
 */
const LINE: Record<Trend, string> = {
  none: "#695cff",
  up: "#1DA66A",
  down: "#E5484D",
  flat: "#9CA1A6",
};

type Trend = "none" | "up" | "down" | "flat";

const dateLabel = (ts: number) =>
  new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
const tooltipLabel = (ts: number) =>
  new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

/** Round a step size to a nice value (1/2/2.5/5 × 10^k) for axis ticks. */
function niceTicks(
  min: number,
  max: number,
  count = 5,
  /** The series only takes whole values, so the scale may not offer a fraction of one. */
  integral = false,
): number[] {
  if (min === max) {
    return [min];
  }
  const rough = (max - min) / (count - 1);
  const pow = 10 ** Math.floor(Math.log10(rough));
  let step = ([1, 2, 2.5, 5, 10].find((b) => rough / pow <= b) ?? 10) * pow;
  // A count of movements cannot be 0.25, and an empty wallet is exactly where this bites: the
  // flat-series clamp below opens the scale to 0..1, which lands on a quarter step and rules the
  // card at three values the data can never take. `sparkline.tsx` had this written down and the
  // port dropped it.
  if (integral) {
    step = Math.max(1, Math.round(step));
  }
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) {
    ticks.push(+v.toFixed(6));
  }
  return ticks;
}

export function PriceChart({
  points,
  trend = "none",
  /**
   * How a value reads on the axis and in the tooltip. The default is the bare number, because the
   * series this started with is a count and a `$` in front of one would be a unit the page cannot
   * source. A caller plotting money passes its own formatter rather than this file guessing which
   * it has.
   */
  format = (v: number) => String(v),
  /** True for a series that holds its value between readings, which every balance does. */
  step = false,
}: {
  points: Point[];
  trend?: Trend;
  format?: (value: number) => string;
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

  // A constant by another name, so it is not a memo dependency.
  const plotLeft = MARGIN.left;
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;

  // **The scale is worked out before the width is.** Its ticks decide how wide the label gutter has
  // to be, and the plot gets what is left. The other way round, the gutter is a guess: 48px fitted
  // a count and cut the last character off every dollar figure.
  const scale = useMemo(() => {
    if (points.length < 2) {
      return { ticks: [] as number[], min: 0, span: 1 };
    }
    const values = points.map((p) => p.value);
    const integral = values.every(Number.isInteger);
    let low = Math.min(...values);
    let high = Math.max(...values);
    if (low === high) {
      // A flat series still gets room around the line, so it reads as a measurement rather than
      // as a chart that failed to draw. Never below zero, though: a balance and a count are both
      // things that cannot be negative, and a scale running to -1 puts a flat run in the middle of
      // the card with a gradient hanging under it, as if half the readings were below nothing.
      low = Math.max(0, low - 1);
      high += 1;
    }
    return {
      ticks: niceTicks(low, high, 5, integral),
      min: low,
      span: high - low,
    };
  }, [points]);

  const { ticks, min, span } = scale;
  const right = gutter(ticks.map(format));
  const plotW = Math.max(0, width - plotLeft - right);

  const pts = useMemo(() => {
    if (points.length < 2 || plotW <= 0) {
      return [] as XY[];
    }
    // Not `step`: the prop of that name is the geometry, and shadowing it here is how a stepped
    // line quietly becomes a sloped one.
    const dx = plotW / (points.length - 1);
    return points.map((p, i) => ({
      x: +(plotLeft + i * dx).toFixed(2),
      y: +(MARGIN.top + (1 - (p.value - min) / span) * plotH).toFixed(2),
    }));
  }, [points, plotW, plotH, min, span]);

  const xTickIdx = useMemo(() => {
    if (pts.length === 0) {
      return [] as number[];
    }
    const count = Math.max(2, Math.min(7, Math.floor(plotW / PX_PER_X_LABEL)));
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
    const x = e.clientX - el.getBoundingClientRect().left - plotLeft;
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
      className="relative w-full overflow-hidden rounded-2xl bg-shade/50"
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
              <stop stopColor={LINE[trend]} stopOpacity="0.22" />
              <stop offset="1" stopColor={LINE[trend]} stopOpacity="0" />
            </linearGradient>
          </defs>
          {ticks.map((t) => {
            const y = MARGIN.top + (1 - (t - min) / span) * plotH;
            return (
              <g key={t}>
                <line
                  stroke="#111827"
                  strokeDasharray="3 4"
                  strokeOpacity="0.08"
                  x1={plotLeft}
                  x2={plotLeft + plotW}
                  y1={y}
                  y2={y}
                />
                <text
                  className="tabular"
                  fill="#83878b"
                  fontSize="11"
                  x={width - right + 10}
                  y={y + 4}
                >
                  {format(t)}
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
              {dateLabel(points[i]?.timestamp ?? 0)}
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
            {format(hoveredPoint.value)}
          </div>
          <div className="whitespace-nowrap text-[11px] text-soft">
            {tooltipLabel(hoveredPoint.timestamp)}
          </div>
        </div>
      ) : null}
    </div>
  );
}
