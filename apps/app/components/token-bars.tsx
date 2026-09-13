"use client";

import { formatUnits } from "viem";

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
 * **Scaled within a side, not across the list.** The first version shared one scale over raw
 * units, which was fine while every line was six-decimal USDC. The night a WETH side existed the
 * receipts' wei figures filled the track and $1.98 of USDC read as nothing. A token is now scaled
 * against the largest line of its own kind — the USDC side, the WETH side, or itself when its
 * kind is unknown — in its own units, so a bar says "how much of this side is this line" and
 * never compares a wei to a cent. The number beside it is still the fact; the bar is a shape.
 */
export function TokenBars({ totals }: { totals: Map<string, bigint> }) {
  const rows = [...totals.entries()]
    .map(([address, value]) => {
      const t = token(address);
      const units =
        t.decimals === null
          ? Number(value)
          : Number(formatUnits(value, t.decimals));
      return { address, value, units, group: t.side ?? t.symbol, ...t };
    })
    .filter((r) => r.value > 0n);

  if (rows.length === 0) return null;

  const maxOf = new Map<string, number>();
  for (const r of rows) {
    maxOf.set(r.group, Math.max(maxOf.get(r.group) ?? 0, r.units));
  }
  // Sides first, in their own units, largest line first within each.
  const order = ["USDC", "WETH"];
  const groups = [...new Set(rows.map((r) => r.group))].sort(
    (a, b) =>
      (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) -
      (order.indexOf(b) === -1 ? 99 : order.indexOf(b)),
  );
  const several = groups.length > 1;

  return (
    <div className="mt-4">
      <p className="text-[11.5px] text-soft">Still spendable, by token</p>
      {groups.map((g) => (
        <div className="mt-2.5" key={g}>
          {several ? (
            <p className="font-mono text-[10.5px] text-faint uppercase tracking-wide">
              {order.includes(g) ? `${g} side` : g}
            </p>
          ) : null}
          <ul className="mt-1.5 space-y-2">
            {rows
              .filter((r) => r.group === g)
              .sort((a, b) => b.units - a.units)
              .map((r) => (
                <li className="flex items-center gap-3" key={r.address}>
                  <span className="w-16 shrink-0 truncate font-mono text-[11.5px] text-body">
                    {r.symbol}
                  </span>
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-shade">
                    <span
                      className="block h-full rounded-full bg-[var(--helico-on)]"
                      style={{
                        width: `${Math.max(1, Math.round((r.units / (maxOf.get(g) || 1)) * 100))}%`,
                      }}
                    />
                  </span>
                  <span className="tabular w-28 shrink-0 text-right font-mono text-[11.5px] text-ink">
                    {amount(r.value, r.decimals)}
                  </span>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
