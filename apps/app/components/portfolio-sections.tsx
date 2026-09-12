"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowLeftRight, ChevronDown, Search, Wallet } from "lucide-react";
import { useState } from "react";
import { formatUnits } from "viem";
import { useAccount, usePublicClient } from "wagmi";

import {
  AssetTile,
  Card,
  Empty,
  Loading,
  SectionTitle,
} from "@/components/kit";
import { TokenMark } from "@/components/token-mark";
import { VenueMark } from "@/components/venue-mark";
import { CHAIN_ID, totals, useAccountState } from "@/hooks/use-account-state";
import { readAccountActivity, withoutVenueLegs } from "@/lib/activity";
import { readMovements } from "@/lib/mandates";
import { MARKETS, readVenues } from "@/lib/venues";

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

const SPLITS = ["All assets", "Liquid", "Working"] as const;

/**
 * What the account holds, where, and what share each part is.
 *
 * **This was two cards and they were the same card.** "Holdings" listed the two rows and
 * "Portfolio allocation" printed one big percentage of the same numbers — which is 100% whenever
 * an account holds one asset, and this account holds one asset. A figure that cannot be anything
 * but 100% is not a reading.
 *
 * So the split moved onto the rows. Each line carries its own share, the tabs filter which lines
 * show, and the giant number is gone. One card answers "what do I have", "where is it" and "how
 * is it divided" without a reader comparing two boxes to work out that they agree.
 *
 * **And "working" names the market now.** `useAccountState` totals what is at work and cannot say
 * where, because that is a sweep over venues rather than one read; `readVenues` does say. Half a
 * dollar sitting in Morpho reads as `USDC · Morpho` rather than `USDC · working`, which is the
 * question somebody opens this page to answer.
 */
export function Holdings() {
  const { data, isPending: pending } = useAccountState();
  const held = totals(data);
  const client = usePublicClient({ chainId: CHAIN_ID });
  const [tab, setTab] = useState<(typeof SPLITS)[number]>("All assets");

  // The account's own address, which left the page with the panel this replaced. It is the one
  // fact here a person cannot get anywhere else: CREATE2 gives it before the contract exists.
  const account =
    data && data.kind !== "unconfigured" ? (data.address as string) : null;

  // Where the working half actually is. A failure here costs the market's name and nothing else:
  // the row still shows, still says "working", and still carries the right amount.
  const venues = useQuery({
    enabled: Boolean(account && client && data?.kind === "open"),
    queryKey: ["holdings-venues", account],
    queryFn: () =>
      readVenues(
        client as NonNullable<typeof client>,
        account as `0x${string}`,
      ),
    retry: false,
    staleTime: 30_000,
  });

  const share = (v: bigint) =>
    held && held.total > 0n
      ? `${(Number((v * 1000n) / held.total) / 10).toFixed(1)}%`
      : "";

  type Row = { key: string; note: string; tint: string; value: bigint };
  const working: Row[] = (venues.data?.positions ?? [])
    .filter((position) => position.supplied > 0n)
    .map((position) => ({
      key: `${position.pool}-${position.asset}`,
      note:
        MARKETS.find(
          (m) => m.pool.toLowerCase() === position.pool.toLowerCase(),
        )?.label ?? "working",
      tint: "bg-[#ecf5f0]",
      value: position.supplied,
    }));
  // The fallback is the total rather than nothing. `useAccountState` is the floor on what is at
  // work — it reads the receipt directly — so a venue sweep that failed or has not answered must
  // not make money at work disappear from the page.
  const workingRows: Row[] =
    working.length > 0
      ? working
      : held && held.working > 0n
        ? [
            {
              key: "working",
              note: "working",
              tint: "bg-[#ecf5f0]",
              value: held.working,
            },
          ]
        : [];
  const liquidRows: Row[] =
    held && held.idle > 0n
      ? [
          {
            key: "liquid",
            note: "liquid",
            tint: "bg-[#eef3fb]",
            value: held.idle,
          },
        ]
      : [];
  const rows =
    tab === "Liquid"
      ? liquidRows
      : tab === "Working"
        ? workingRows
        : [...liquidRows, ...workingRows];

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

      {/* A pair of bars while the chain is read. An empty state before the answer arrives says
          "you hold nothing", which is a different claim from "we have not looked yet". */}
      {pending ? (
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Loading className="h-[68px]" />
          <Loading className="h-[68px]" />
        </div>
      ) : rows.length > 0 ? (
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {rows.map((r) => (
            <AssetTile
              key={r.key}
              mark={<TokenMark size={22} symbol="USDC" />}
              note={r.note}
              share={share(r.value)}
              symbol="USDC"
              tint={r.tint}
              value={usdc(r.value)}
            />
          ))}
        </div>
      ) : (
        <Empty icon={Wallet}>
          {held && held.total > 0n
            ? `Nothing ${tab.toLowerCase()} right now. The other tab has it.`
            : "Nothing in here yet. Put something into your account and it shows up on this page."}
        </Empty>
      )}
    </Card>
  );
}

/**
 * What has happened, and it is two questions rather than one.
 *
 * **The panel used to read Aqua movements for the wallet and nothing else**, so it sat empty on an
 * account that had just been armed, funded, and had capital supplied to a lending market by the
 * enclave. Three things happened and the page said nothing had — it was answering a narrower
 * question than its own title asks.
 *
 * The account's own events answer the rest, from its own logs, with no subgraph involved. Aqua
 * movements stay: a fill against a shipped mandate is not the same event as the agent moving idle
 * capital, and a reader wants both in one list, newest first.
 */
/**
 * What has happened, as a table with a column per fact.
 *
 * **It was a list of sentences and the facts were buried in them.** "Put 0.49 USDC to work in
 * Morpho" reads fine once; eight of them is a paragraph a person scans for the number. The amount,
 * the market and the date each get a column, so a column can be read down instead of every row
 * being read across — which is what the reference Ghoza sent does.
 *
 * **The date comes from the backend or not at all.** A log carries no timestamp, so it is one block
 * header per block, fetched once and kept for ever. The chain fallback does not fetch them: a
 * header per block from every browser is the cost this path exists to avoid, and an empty date
 * beats an invented one.
 *
 * Two questions are answered here. The account's own events come from its logs; Aqua movements are
 * fills against a shipped mandate, which is a different thing, and both belong in one list.
 */
export function Activity() {
  const { address } = useAccount();
  const { data } = useAccountState();
  const client = usePublicClient({ chainId: CHAIN_ID });
  const account =
    data && data.kind === "open" ? (data.address as `0x${string}`) : null;

  const moves = useQuery({
    enabled: Boolean(address),
    queryKey: ["movements", address],
    queryFn: () => readMovements(address as string),
  });
  const own = useQuery({
    enabled: Boolean(account && client),
    queryKey: ["account-activity", account],
    queryFn: () =>
      readAccountActivity(
        client as NonNullable<typeof client>,
        account as `0x${string}`,
      ),
    retry: false,
    staleTime: 15_000,
  });

  // The transfer that carries a supply out of the account is the other half of the move beside it,
  // and two rows for one transaction reads as the money leaving twice.
  const rows = [
    ...withoutVenueLegs(own.data ?? []).map((e) => ({
      key: e.key,
      what: e.what,
      amount: e.amount,
      where: e.where,
      at: e.at,
      tx: e.tx as string | null,
    })),
    ...(moves.data?.timestamps ?? []).map((t) => ({
      key: `aqua-${t}`,
      what: "Filled through a mandate",
      amount: "",
      where: "Aqua",
      at: t,
      tx: null as string | null,
    })),
  ].slice(0, 10);

  const pending = (moves.isPending && Boolean(address)) || own.isPending;
  const when = (at: number | null) =>
    at
      ? new Date(at * 1000).toLocaleDateString(undefined, {
          day: "numeric",
          month: "short",
          year: "numeric",
        })
      : "—";

  return (
    <Card>
      <SectionTitle>Recent activity</SectionTitle>
      {pending ? (
        <Loading className="mt-4 h-24" />
      ) : rows.length === 0 ? (
        <Empty icon={ArrowLeftRight}>
          Nothing yet. Naming an agent, allowing a market, and the agent moving
          capital all turn up here.
        </Empty>
      ) : (
        <div className="-mx-1 mt-4 overflow-x-auto px-1">
          <table className="w-full min-w-[520px] border-collapse text-left">
            <thead>
              <tr className="border-line border-b text-[11.5px] text-faint">
                <th className="pb-2 font-normal">What</th>
                <th className="pb-2 text-right font-normal">Amount</th>
                <th className="pb-2 pl-4 font-normal">Where</th>
                <th className="pb-2 pl-4 font-normal">Date</th>
                <th className="pb-2 pl-4 text-right font-normal">
                  Transaction
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr className="text-[12.5px]" key={r.key}>
                  <td className="py-2.5 text-ink">{r.what}</td>
                  <td className="tabular py-2.5 text-right font-mono text-ink">
                    {r.amount || "—"}
                  </td>
                  <td className="py-2.5 pl-4">
                    {r.where ? (
                      <span className="flex items-center gap-1.5 text-soft">
                        {r.where === "Aqua" ? null : (
                          <VenueMark label={r.where} size={14} />
                        )}
                        {r.where}
                      </span>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </td>
                  <td className="tabular py-2.5 pl-4 text-soft">
                    {when(r.at)}
                  </td>
                  <td className="py-2.5 pl-4 text-right">
                    {r.tx ? (
                      <a
                        className="tabular font-mono text-[11.5px] text-faint underline underline-offset-2 hover:text-ink"
                        href={`https://arbiscan.io/tx/${r.tx}`}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {r.tx.slice(0, 10)}…
                      </a>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
