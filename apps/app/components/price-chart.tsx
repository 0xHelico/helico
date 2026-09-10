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

const linePath = (pts: XY[]) =>
  pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join("");

function areaPath(pts: XY[], height: number): string {
  const last = pts.at(-1);
  return last
    ? `${linePath(pts)}L${last.x},${height}L${pts[0]?.x ?? 0},${height}Z`
    : "";
}

const HEIGHT = 240;
const MARGIN = { top: 16, right: 48, bottom: 28, left: 8 };
const PX_PER_X_LABEL = 110;
const TOOLTIP_HALF_WIDTH = 70;

/** Helico's own line, rather than the reference's red-or-green: a movement count has no direction
 *  to be good or bad about, and a green line climbing would claim one. */
const LINE = "#695cff";

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

export function PriceChart({ points }: { points: Point[] }) {
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
  const plotW = Math.max(0, width - plotLeft - MARGIN.right);
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;

  const { pts, ticks, min, span } = useMemo(() => {
    if (points.length < 2 || plotW <= 0) {
      return { pts: [] as XY[], ticks: [] as number[], min: 0, span: 1 };
    }
    const values = points.map((p) => p.value);
    let low = Math.min(...values);
    let high = Math.max(...values);
    if (low === high) {
      // A flat series still gets room around the line, so it reads as a measurement rather than
      // as a chart that failed to draw. Never below zero, though: this counts movements, and a
      // scale that runs to -1 puts a flat run of quiet days in the middle of the card with a
      // gradient hanging under it, as if half the readings were negative.
      low = Math.max(0, low - 1);
      high += 1;
    }
    const range = high - low;
    const step = plotW / (points.length - 1);
    return {
      pts: values.map((v, i) => ({
        x: +(plotLeft + i * step).toFixed(2),
        y: +(MARGIN.top + (1 - (v - low) / range) * plotH).toFixed(2),
      })),
      ticks: niceTicks(low, high, 5),
      min: low,
      span: range,
    };
  }, [points, plotW, plotH]);

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
              <stop stopColor={LINE} stopOpacity="0.22" />
              <stop offset="1" stopColor={LINE} stopOpacity="0" />
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
                  x={width - MARGIN.right + 10}
                  y={y + 4}
                >
                  {t}
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
            d={areaPath(pts, MARGIN.top + plotH)}
            fill={`url(#${id})`}
          />
          <path
            className="chart-line"
            d={linePath(pts)}
            fill="none"
            pathLength={1}
            stroke={LINE}
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
                fill={LINE}
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
            {hoveredPoint.value} {hoveredPoint.value === 1 ? "move" : "moves"}
          </div>
          <div className="whitespace-nowrap text-[11px] text-soft">
            {tooltipLabel(hoveredPoint.timestamp)}
          </div>
        </div>
      ) : null}
    </div>
  );
}
