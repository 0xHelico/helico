"use client";

import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeftRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Search,
  Wallet,
} from "lucide-react";
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
import { pageOf, readAccountActivity, withoutVenueLegs } from "@/lib/activity";
import { amount, collapse, readMovements, token } from "@/lib/mandates";
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
        {/* The heading alone. The account's address and whether it is open are on the Limits page,
            where they are what somebody came for; here they sat under a list of balances that
            could only have been read from that account in the first place. */}
        <SectionTitle>Holdings</SectionTitle>
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

  // **Both makers.** The account is the maker for anything shipped through it, and the wallet is
  // the maker for `provide-card`; asking only the wallet hid every position the one-press card
  // ever shipped. `makers` is the query key too, so connecting an account refetches.
  const makers = [account, address].filter(Boolean) as string[];
  const moves = useQuery({
    enabled: makers.length > 0,
    queryKey: ["movements", ...makers],
    queryFn: () => readMovements(makers),
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
    // **A ship is a movement, so the direction decides the sentence.** Aqua emits `Pushed` per
    // token when a mandate is shipped, and this list used to call every movement *"Filled through
    // a mandate"* — which for this account would have been seven claims that money left a wallet
    // nothing has ever taken from. `PULL` is the only one of the two that is a fill.
    ...collapse(moves.data?.events ?? []).map((m) => {
      const t = token(m.token);
      return {
        key: `aqua-${m.tx}-${m.token}-${m.direction}`,
        what:
          m.direction === "PULL"
            ? "Filled through a mandate"
            : "Made quotable on Aqua",
        amount: `${amount(m.amount, t.decimals)} ${t.symbol}`,
        where: "Aqua",
        at: m.at,
        tx: m.tx as string | null,
      };
    }),
  ]
    // **Sorted, which it was not.** The account's own events arrive newest first and the Aqua
    // movements arrive oldest first — `readMovements` asks for `orderDirection: asc` — so
    // concatenating them put a list in two directions at once and then cut the middle out of it
    // with `slice`. A recent-activity table whose rows are not in time order is worse than no
    // table: every row is true and the sequence they imply is invented.
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));

  /**
   * A page at a time, instead of throwing the rest away.
   *
   * This was `.slice(0, 10)`, which is not a page — it is a list that silently ends. The tenth
   * row gave no sign that an eleventh existed, so an account with any history at all showed a
   * table that looked complete and was not. Ten still shows at once; what changed is that the
   * rest is reachable.
   *
   * **Clamped rather than reset.** The row set shrinks when a wallet disconnects or a query
   * refetches shorter, and a stored index would strand the reader on a page that no longer
   * exists — an empty table with no rows and no error, which reads as "nothing ever happened".
   * Clamping needs no effect and cannot get out of step with the data it indexes.
   */
  const [page, setPage] = useState(0);
  const { pages, current, from, count } = pageOf(rows.length, page, PAGE);
  const shown = rows.slice(from, from + count);

  const pending = (moves.isPending && makers.length > 0) || own.isPending;

  /**
   * The day, and the time under it.
   *
   * Two lines rather than one string, because the two are read for different reasons: the date
   * is what you scan down the column, and the clock is what you check on one row. A single
   * `12 Sep 2026, 13:55` makes the scan read the clock too.
   *
   * The minute matters here more than it looks. Two of this account's rows are 54 seconds apart
   * — a mandate shipped, and the agent unwinding a position to cover it — and to the day they
   * are the same fact twice.
   */
  const day = (at: number) =>
    new Date(at * 1000).toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  const clock = (at: number) =>
    new Date(at * 1000).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });

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
        <>
          {/* **The table scrolls sideways; the pager must not.** `min-w-[520px]` is what keeps the
              five columns legible on a phone, and the container that allows for it scrolls its
              whole content — so a pager inside it is 520px wide too, and `Older` sits off the
              right edge until the reader scrolls to find the control they were looking for. The
              scroll box holds the wide thing and nothing else. */}
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
                {shown.map((r) => (
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
                      {r.at ? (
                        // The full stamp on hover, including the seconds the cell has no room
                        // for — the two rows a minute apart are the ones somebody will want it on.
                        <span title={new Date(r.at * 1000).toLocaleString()}>
                          {day(r.at)}
                          <span className="block text-[11px] text-faint">
                            {clock(r.at)}
                          </span>
                        </span>
                      ) : (
                        <span className="text-faint">—</span>
                      )}
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
          {pages > 1 ? (
            <Pages
              capped={moves.data?.capped ?? false}
              from={from}
              onPage={setPage}
              page={current}
              pages={pages}
              shown={shown.length}
              total={rows.length}
            />
          ) : null}
        </>
      )}
    </Card>
  );
}

/** How many rows one page of the activity table holds. Ten, as the old `slice` showed. */
const PAGE = 10;

/**
 * The pager under the activity table.
 *
 * **Only drawn when there is a second page.** A disabled pair of arrows under a four-row table
 * is furniture that says "there is more" and then refuses — worse than no control, because the
 * reader spends a click finding out.
 *
 * **The count is honest about its own limit.** `readMovements` asks for one page of 1,000 and
 * reports `capped` when it came back full, so a busier maker's total is a floor rather than a
 * total. Printing `1–10 of 1000` there would be a number nobody measured; it says `of 1000+`
 * instead, which is the same fact without the claim.
 */
function Pages({
  page,
  pages,
  from,
  shown,
  total,
  capped,
  onPage,
}: {
  page: number;
  pages: number;
  from: number;
  shown: number;
  total: number;
  capped: boolean;
  onPage: (n: number) => void;
}) {
  const step = (by: number) =>
    onPage(Math.min(pages - 1, Math.max(0, page + by)));
  return (
    <div className="mt-3 flex items-center justify-between border-line border-t pt-3">
      <p className="tabular text-[11.5px] text-faint">
        {`${from + 1}–${from + shown} of ${total}${capped ? "+" : ""}`}
      </p>
      <div className="flex items-center gap-1">
        <PageButton
          disabled={page === 0}
          label="Newer"
          onClick={() => step(-1)}
        >
          <ChevronLeft className="size-3.5" />
        </PageButton>
        <PageButton
          disabled={page >= pages - 1}
          label="Older"
          onClick={() => step(1)}
        >
          <ChevronRight className="size-3.5" />
        </PageButton>
      </div>
    </div>
  );
}

/**
 * One arrow.
 *
 * `aria-label` rather than text, and `title` so a mouse gets the same word: the direction of an
 * arrow in a table of dates is not obvious — up could mean newer or earlier in the list — and
 * "Newer" and "Older" are the words the rows are actually sorted by.
 */
function PageButton({
  children,
  label,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      className="flex size-6 items-center justify-center rounded-md border border-line text-soft transition-colors hover:border-ink/25 hover:text-ink disabled:pointer-events-none disabled:opacity-35"
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}
