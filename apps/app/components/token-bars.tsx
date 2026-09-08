"use client";

import { amount, token } from "@/lib/mandates";

/**
 * What is left, per token, as bars.
 *
 * Magnitude by category, so bars — and horizontal, because the categories are token symbols
 * rather than points in time and a row reads left to right.
 *
 * **One hue for every bar.** Identity is already carried by the label beside each one, so
 * colouring them differently would encode nothing and would need a categorical palette to stay
 * legible under colour blindness. The bar length is the only thing saying anything here.
 *
 * Each token is scaled against itself in nothing — the bars share one scale, and that scale is
 * the largest balance. Comparing 40,000 USDC against 0.3 WETH as lengths would be meaningless,
 * so the number is always printed and the bar is only a shape for the eye to sort by.
 */
export function TokenBars({ totals }: { totals: Map<string, bigint> }) {
  const rows = [...totals.entries()]
    .map(([address, value]) => {
      const t = token(address);
      return { address, value, ...t };
    })
    .filter((r) => r.value > 0n)
    .sort((a, b) => (a.value < b.value ? 1 : -1));

  if (rows.length === 0) return null;

  // Share of the largest, so the longest bar fills the track. A percentage of a total would be
  // worse: these are different tokens, and their sum is not a quantity of anything.
  const max = rows.reduce((m, r) => (r.value > m ? r.value : m), 1n);

  return (
    <div className="mt-4">
      <p className="text-[11.5px] text-soft">Still spendable, by token</p>
      <ul className="mt-2.5 space-y-2">
        {rows.map((r) => (
          <li className="flex items-center gap-3" key={r.address}>
            <span className="w-16 shrink-0 truncate font-mono text-[11.5px] text-body">
              {r.symbol}
            </span>
            <span className="h-2 flex-1 overflow-hidden rounded-full bg-shade">
              <span
                className="block h-full rounded-full bg-[var(--helico-on)]"
                style={{ width: `${Number((r.value * 100n) / max)}%` }}
              />
            </span>
            <span className="tabular w-28 shrink-0 text-right font-mono text-[11.5px] text-ink">
              {amount(r.value, r.decimals)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
