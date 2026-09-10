"use client";

import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeftRight,
  ChartPie,
  ChevronDown,
  Search,
  Wallet,
} from "lucide-react";
import { useState } from "react";
import { formatUnits } from "viem";
import { useAccount } from "wagmi";

import {
  AssetTile,
  Card,
  Empty,
  Loading,
  SectionTitle,
} from "@/components/kit";
import { TokenMark } from "@/components/token-mark";
import { totals, useAccountState } from "@/hooks/use-account-state";
import { readMovements } from "@/lib/mandates";

/**
 * The three sections under the hero, in the order the reference lays them out: what is held, how
 * it is split, and what has happened.
 *
 * Each is the same shape — a title row, then either content or a centred empty state — because the
 * page reads as one thing only if a section that has nothing to say looks like a section rather
 * than a gap.
 */

const usdc = (v: bigint) =>
  Number(formatUnits(v, 6)).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/** A control that is a label and a chevron. Inert until there is more than one of anything to
 *  filter, which is a state this account reaches by holding a second asset. */
function Filter({ label }: { label: string }) {
  return (
    <button
      className="flex items-center gap-1 rounded-lg px-2 py-1 text-[12.5px] text-soft transition-colors hover:text-ink disabled:opacity-60"
      disabled
      type="button"
    >
      {label}
      <ChevronDown className="size-3.5" />
    </button>
  );
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function Holdings() {
  const { data } = useAccountState();
  const held = totals(data);
  // The account's own address, which left the page with the panel this replaced. It is the one
  // fact here a person cannot get anywhere else: CREATE2 gives it before the contract exists.
  const account =
    data && data.kind !== "unconfigured" ? (data.address as string) : null;
  const rows =
    held && held.total > 0n
      ? [
          { note: "liquid", tint: "bg-[#eef3fb]", value: usdc(held.idle) },
          { note: "working", tint: "bg-[#ecf5f0]", value: usdc(held.working) },
        ]
      : [];

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <SectionTitle>Holdings</SectionTitle>
          {account ? (
            <p className="tabular mt-1 font-mono text-[11.5px] text-faint">
              Account {short(account)} ·{" "}
              {data?.kind === "open" ? "open" : "not opened yet"}
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <Filter label="Asset class" />
          <Filter label="Network" />
          <span className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-[12.5px] text-faint">
            <Search className="size-3.5" />
            Search asset
          </span>
        </div>
      </div>

      {rows.length > 0 ? (
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {rows.map((r) => (
            <AssetTile
              key={r.note}
              mark={<TokenMark size={22} symbol="USDC" />}
              note={r.note}
              symbol="USDC"
              tint={r.tint}
              value={r.value}
            />
          ))}
        </div>
      ) : (
        <Empty icon={Wallet}>
          No holdings found. Fund your account to see its assets in one place.
        </Empty>
      )}
    </Card>
  );
}

const SPLITS = ["All assets", "Liquid", "Working"] as const;

export function Allocation() {
  const { data } = useAccountState();
  const held = totals(data);
  const [tab, setTab] = useState<(typeof SPLITS)[number]>("All assets");

  const share =
    held && held.total > 0n
      ? tab === "Liquid"
        ? Number((held.idle * 1000n) / held.total) / 10
        : tab === "Working"
          ? Number((held.working * 1000n) / held.total) / 10
          : 100
      : null;

  return (
    <Card>
      <SectionTitle>Portfolio allocation</SectionTitle>
      <div className="mt-3 flex gap-6 border-line border-b">
        {SPLITS.map((s) => (
          <button
            className={`-mb-px border-b-2 pb-2 text-[12.5px] transition-colors ${
              tab === s
                ? "border-ink text-ink"
                : "border-transparent text-soft hover:text-ink"
            }`}
            key={s}
            onClick={() => setTab(s)}
            type="button"
          >
            {s}
          </button>
        ))}
      </div>

      {share === null ? (
        <Empty icon={ChartPie}>
          Allocation appears once the account holds something.
        </Empty>
      ) : (
        <div className="py-10 text-center">
          <div className="tabular font-medium text-4xl text-ink tracking-tight">
            {share.toFixed(1)}
            <span className="text-faint">%</span>
          </div>
          <p className="mt-2 text-[12.5px] text-soft">
            of what this account holds, {tab.toLowerCase()}
          </p>
        </div>
      )}
    </Card>
  );
}

export function Activity() {
  const { address } = useAccount();
  const moves = useQuery({
    enabled: Boolean(address),
    queryKey: ["movements", address],
    queryFn: () => readMovements(address as string),
  });

  return (
    <Card>
      <SectionTitle>Recent activity</SectionTitle>
      {moves.isPending && address ? (
        <Loading className="mt-4 h-24" />
      ) : (moves.data?.timestamps.length ?? 0) === 0 ? (
        <Empty icon={ArrowLeftRight}>
          No activity yet. Anything the agent moves through Aqua shows up here.
        </Empty>
      ) : (
        <ul className="mt-4 divide-y divide-line">
          {(moves.data?.timestamps ?? [])
            .slice(-8)
            .reverse()
            .map((t) => (
              <li
                className="flex items-center justify-between py-2.5 text-[12.5px]"
                key={t}
              >
                <span className="text-ink">Moved through a mandate</span>
                <span className="tabular text-faint">
                  {new Date(t * 1000).toLocaleDateString()}
                </span>
              </li>
            ))}
        </ul>
      )}
    </Card>
  );
}
