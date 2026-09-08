"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { isAddress } from "viem";
import { useAccount } from "wagmi";

import { Glyph } from "@/components/glyph";
import { Input } from "@/components/ui/input";
import { amount, type MandateView, readMandates, token } from "@/lib/mandates";

/** A maker with 48 live mandates on Arbitrum One. Not ours, which is the point. */
const EXAMPLE = "0xef9f7f4006fe95afede04f6916e72556a957ebbc";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 rounded-2xl border border-dashed p-4">
      <p className="text-muted-foreground text-xs leading-relaxed">
        {children}
      </p>
    </div>
  );
}

/**
 * Every mandate a wallet has, and what is left in each.
 *
 * This is the panel that could not exist without an indexer. Aqua's `_balances` is private and
 * four levels deep, `rawBalances` needs a hash you already hold, and no event parameter is
 * indexed — so "which mandates does this wallet have" has no on-chain answer at all. Not a slow
 * one. None.
 *
 * It takes a typed address as well as the connected wallet, because the claim is true of any
 * wallet and reads better when the reader picks one.
 */
export function MandatesPanel() {
  const { address } = useAccount();
  const [typed, setTyped] = useState("");
  const maker = isAddress(typed) ? typed : (address ?? "");

  const { data, error, isPending, refetch } = useQuery<MandateView>({
    enabled: Boolean(maker),
    queryKey: ["mandates", maker],
    queryFn: () => readMandates(maker),
  });

  const field = (
    <Input
      aria-label="Look up another address"
      className="mt-3 h-8 font-mono text-xs"
      onChange={(e) => setTyped(e.target.value.trim())}
      placeholder={`Any address — try ${short(EXAMPLE)}`}
      value={typed}
    />
  );

  const body = () => {
    if (!maker) {
      return (
        <Shell>
          Connect a wallet, or paste any address. Nothing here is ours: it is
          read from a subgraph over the Aqua 1inch deployed, and it works for
          every maker on the chain.
        </Shell>
      );
    }
    if (isPending) return <Shell>Reading the subgraph…</Shell>;
    if (error) {
      return (
        <Shell>
          The subgraph did not answer: {error.message.split("\n")[0]}.{" "}
          <button
            className="underline underline-offset-2"
            onClick={() => refetch()}
            type="button"
          >
            Try again
          </button>
        </Shell>
      );
    }
    if (data.rows.length === 0) {
      return (
        <Shell>
          No mandates for {short(maker)}. That is an answer, not a failure — and
          it is one only an indexer can give, because the chain cannot list them
          either way.
        </Shell>
      );
    }
    return (
      <>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[520px] text-left text-xs">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="py-2 pr-4 font-medium">Mandate</th>
                <th className="py-2 pr-4 font-medium">App</th>
                <th className="py-2 pr-4 font-medium">Spendable</th>
                <th className="py-2 pr-4 font-medium">Moves</th>
                <th className="py-2 font-medium">State</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {data.rows.map((m) => (
                <tr key={m.strategyHash}>
                  <td className="py-2 pr-4 font-mono">
                    {short(m.strategyHash)}
                  </td>
                  <td className="py-2 pr-4 font-mono">{short(m.app)}</td>
                  <td className="py-2 pr-4 font-mono">
                    {m.balances
                      .filter((b) => b.spendable)
                      .map((b) => {
                        const t = token(b.token);
                        return `${amount(b.amount, t.decimals)} ${t.symbol}`;
                      })
                      .join(" · ") || "—"}
                  </td>
                  <td className="py-2 pr-4 font-mono">{m.movements}</td>
                  <td className="py-2">
                    <span
                      className={
                        m.active
                          ? "text-[var(--helico-on)]"
                          : "text-muted-foreground/60"
                      }
                    >
                      {m.active ? "live" : "docked"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3.5 text-[10.5px] text-muted-foreground/70 leading-relaxed">
          {data.rows.length} mandate{data.rows.length === 1 ? "" : "s"},{" "}
          {data.active} still live. A docked one reports zero because docking
          zeroes the ledger, so the state comes from Aqua&rsquo;s own sentinel
          rather than from the amount — the two are indistinguishable otherwise.
        </p>
      </>
    );
  };

  return (
    <div className="mt-5 rounded-2xl border bg-card p-4">
      <div className="flex items-start gap-4">
        <span className="mt-0.5 shrink-0">
          <Glyph name="document" size={34} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-medium text-[13.5px] leading-none">
            What this wallet may spend
          </p>
          <p className="mt-2 text-muted-foreground text-xs leading-relaxed">
            Aqua keeps its balances in a private mapping four levels deep and
            indexes no event parameter. There is no on-chain way to ask this —
            not a slow one, none.
          </p>
          {field}
        </div>
      </div>
      {body()}
    </div>
  );
}
