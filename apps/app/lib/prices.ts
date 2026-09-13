import { API_BASE } from "@/lib/api";

/** One reading of the feed: when, in milliseconds, and the price in dollars. */
export type PricePoint = { t: number; price: number };

/** The price at a moment, in dollars. */
export type PriceAt = (timestampMs: number) => number;

/**
 * Ether's price by the hour over a window, from `GET /api/prices` — the Chainlink ETH/USD feed's
 * own round history, read by the backend and kept.
 *
 * **Null rather than throwing.** A backend that is down is a reason to value the line at today's
 * price, which the page already has, not a reason to show a person an error about a history
 * service they did not know existed. The step is the server's choice: hourly to a month, coarser
 * beyond, never more than 720 points.
 */
export async function fetchPriceSeries(
  fromMs: number,
  toMs: number,
): Promise<PricePoint[] | null> {
  const from = Math.floor(fromMs / 1000);
  const to = Math.ceil(toMs / 1000);
  if (!(from > 0) || to < from) return null;
  try {
    const res = await fetch(
      `${API_BASE}/api/prices?asset=WETH&from=${from}&to=${to}`,
      { headers: { accept: "application/json" } },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      points?: { t: number; price: number }[];
    };
    if (!Array.isArray(body.points)) return null;
    return body.points
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.price))
      .map((p) => ({ t: p.t * 1000, price: p.price }));
  } catch {
    return null;
  }
}

/**
 * The price at any moment, from a table of readings: the last reading at or before it, which is
 * what a feed's answer is between rounds.
 *
 * Before the first reading the first one stands, and with no readings at all the fallback does —
 * the page's live Chainlink price — so a line can always be drawn, and the caption says which
 * of the two it was drawn with.
 */
export function priceAt(
  points: PricePoint[] | null,
  fallback: number,
): PriceAt {
  if (!points || points.length === 0) return () => fallback;
  const sorted = [...points].sort((a, b) => a.t - b.t);
  return (at) => {
    // Binary search for the last reading at or before `at`.
    let lo = 0;
    let hi = sorted.length - 1;
    if (at < (sorted[0]?.t ?? 0)) return sorted[0]?.price ?? fallback;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((sorted[mid]?.t ?? 0) <= at) lo = mid;
      else hi = mid - 1;
    }
    return sorted[lo]?.price ?? fallback;
  };
}
