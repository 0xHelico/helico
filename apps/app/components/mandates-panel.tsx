"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { isAddress } from "viem";
import { useAccount } from "wagmi";

import {
  Card,
  Empty,
  ErrorState,
  Loading,
  SectionTitle,
} from "@/components/kit";
import { byDay, Sparkline } from "@/components/sparkline";
import { Input } from "@/components/ui/input";
import {
  amount,
  type MandateView,
  readMandates,
  readMovements,
  token,
} from "@/lib/mandates";

/** A maker with 48 live mandates on Arbitrum One. Not ours, which is the point. */
const EXAMPLE = "0xef9f7f4006fe95afede04f6916e72556a957ebbc";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * What is left, per token, as one line.
 *
 * A token the app cannot name shows its raw integer — twenty digits wide for an 18-decimal one,
 * which is why the cell truncates and keeps the whole value in a title. Truncated with the
 * number still reachable is honest; scaling it by a guessed 18 would not be.
 */
const spendable = (m: {
  balances: { token: string; amount: bigint; spendable: boolean }[];
}) =>
  m.balances
    .filter((b) => b.spendable)
    .map((b) => {
      const t = token(b.token);
      return `${amount(b.amount, t.decimals)} ${t.symbol}`;
    })
    .join(" · ");

/**
 * Every mandate a wallet has, and what is left in each.
 *
 * The panel that could not exist without an indexer. Aqua's `_balances` is private and four
 * levels deep, `rawBalances` needs a hash you already hold, and no event parameter is indexed —
 * so "which mandates does this wallet have" has no on-chain answer at all. Not a slow one. None.
 *
 * It takes a typed address as well as the connected wallet, because the claim is true of any
 * wallet and reads better when the reader picks one.
 */
export function MandatesPanel() {
  const { address } = useAccount();
  const [typed, setTyped] = useState("");
  const maker = isAddress(typed) ? typed : (address ?? "");

  const mandates = useQuery<MandateView>({
    enabled: Boolean(maker),
    queryKey: ["mandates", maker],
    queryFn: () => readMandates(maker),
  });

  // Its own query, and allowed to fail on its own: the table is the answer and the chart is
  // context, so a chart that will not load must not take the table down with it.
  const moves = useQuery({
    enabled: Boolean(maker),
    queryKey: ["movements", maker],
    queryFn: () => readMovements(maker),
  });

  const body = () => {
    if (!maker) {
      return (
        <Empty>
          Connect a wallet, or paste any address. Nothing here is ours — it is
          read from a subgraph over the Aqua 1inch deployed, and it answers for
          every maker on the chain.
        </Empty>
      );
    }
    if (mandates.isPending) return <Loading className="mt-4 h-40" />;
    if (mandates.error) {
      return (
        <ErrorState
          detail={mandates.error.message.split("\n")[0]}
          onRetry={() => mandates.refetch()}
          what="the mandates"
        />
      );
    }
    const data = mandates.data;
    if (data.rows.length === 0) {
      return (
        <Empty>
          No mandates for {short(maker)}. That is an answer rather than a
          failure, and it is one only an indexer can give — the chain cannot
          list them either way.
        </Empty>
      );
    }
    // The section is titled "what this wallet may spend", and a docked mandate spends nothing.
    // Forty-eight rows where thirty-seven are dashes buries the eleven that answer the question.
    const live = data.rows.filter((m) => m.active);
    const docked = data.rows.length - live.length;

    return (
      <>
        {moves.data && moves.data.timestamps.length > 0 ? (
          <Sparkline
            days={byDay(moves.data.timestamps)}
            label={`Movements per day${moves.data.capped ? ", first 1,000" : ""}`}
          />
        ) : null}

        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-[12.5px]">
            <thead>
              <tr className="border-line border-b text-[11.5px] text-soft">
                <th className="py-2 pr-4 font-medium">Mandate</th>
                <th className="py-2 pr-4 font-medium">App</th>
                <th className="py-2 pr-4 font-medium">Spendable</th>
                <th className="py-2 font-medium">Moves</th>
              </tr>
            </thead>
            <tbody className="divide-line divide-y">
              {live.map((m) => (
                <tr key={m.strategyHash}>
                  <td className="tabular py-2.5 pr-4 font-mono text-body">
                    {short(m.strategyHash)}
                  </td>
                  <td className="tabular py-2.5 pr-4 font-mono text-body">
                    {short(m.app)}
                  </td>
                  <td className="tabular max-w-[16rem] truncate py-2.5 pr-4 font-mono text-ink">
                    <span title={spendable(m) || undefined}>
                      {spendable(m) || "—"}
                    </span>
                  </td>
                  <td className="tabular py-2.5 font-mono text-body">
                    {m.movements}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-4 text-[11px] text-faint leading-relaxed">
          {live.length} live
          {docked > 0 ? `, ${docked} docked and not listed` : ""} of{" "}
          {data.rows.length}. A docked mandate reports zero because docking
          zeroes the ledger, so &ldquo;spendable&rdquo; comes from Aqua&rsquo;s
          own sentinel rather than from the amount — by amount alone the two are
          the same.
        </p>
      </>
    );
  };

  return (
    <Card className="mt-4">
      <SectionTitle>What this wallet may spend</SectionTitle>
      <p className="mt-1.5 text-[12.5px] text-soft leading-relaxed">
        Aqua keeps its balances in a private mapping four levels deep and
        indexes no event parameter. There is no on-chain way to ask this — not a
        slow one, none.
      </p>
      <Input
        aria-label="Look up another address"
        className="mt-3 h-9 border-line font-mono text-[12px]"
        onChange={(e) => setTyped(e.target.value.trim())}
        placeholder={`Any address — try ${short(EXAMPLE)}`}
        value={typed}
      />
      {body()}
    </Card>
  );
}
