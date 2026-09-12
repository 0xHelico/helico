"use client";

import { type Address, type PublicClient, parseAbiItem } from "viem";

import { API_BASE } from "@/lib/api";
import { MARKETS } from "@/lib/venues";

/**
 * What the account itself did, read from its own logs.
 *
 * **Why this exists at all.** "Recent activity" read Aqua movements for the wallet, and Aqua
 * movements are `Pulled`/`Pushed` under a shipped mandate. So the panel sat empty on an account
 * that had just been armed, funded, and had half a dollar supplied to Morpho by the enclave — three
 * things happened and the page said nothing had. It was answering a narrower question than its own
 * title asks.
 *
 * `HelicoAccount` emits an event for each of those three, so the answer is one `eth_getLogs` away
 * and needs no subgraph change. Verified against the live account on 11 September: eight logs,
 * `AgentChanged` twice, `VenuePermitted` four times, and one `IdleCapitalMoved` carrying 490081 of
 * USDC into Morpho.
 *
 * The Aqua movements stay where they are. These are different questions and the page shows both.
 *
 * **The backend answers this now, and the chain is the fallback.** Every browser was scanning from
 * the factory\'s deployment block on every page load — three `eth_getLogs` calls each spanning a
 * million blocks, against a public endpoint everybody shares. `GET /api/activity` owns the history
 * instead: the log is append-only, so a watermark in its database turns the second read into a
 * narrow query. Measured against the live account: 671 ms on the first ask, **0.67 ms** on the next.
 *
 * The direct read stays as the fallback, which is the property `/api/graph` deliberately keeps —
 * this page worked before the backend existed and should not stop working when it is down.
 */
const MOVED = parseAbiItem(
  "event IdleCapitalMoved(address indexed pool, address indexed asset, uint256 amount, bool supplied)",
);
const AGENT = parseAbiItem("event AgentChanged(address indexed agent)");
const VENUE = parseAbiItem(
  "event VenuePermitted(address indexed pool, bool allowed)",
);

export type AccountEvent = {
  /** What the chain said happened, kept beside the sentence so a fold does not read prose. */
  kind: "moved" | "agent" | "venue" | "in" | "out" | "unknown";
  /** Base units of the asset, for the rows that carry one. Zero for the rest. */
  units: bigint;
  /** True for money arriving: supplied to a market, or transferred into the account. */
  into: boolean;
  /** Block first, log index second. Two events in one transaction keep the order they happened. */
  key: string;
  what: string;
  /** The amount, already formatted, for the rows that move money. Empty for the rest. */
  amount: string;
  /** The market, for the rows that name one. Empty for the rest. */
  where: string;
  block: bigint;
  /** Unix seconds, or null when the block's header could not be read. Never invented. */
  at: number | null;
  tx: `0x${string}`;
};

/**
 * A market's name, disambiguated only when it needs to be.
 *
 * Two of the four markets are labelled "Compound v3" — one for USDC and one for ETH — so a list of
 * permissions read "Allowed Compound v3" twice with nothing to tell them apart. True and useless.
 * The asset is appended only for a label that more than one market shares, so the common case stays
 * short.
 */
const marketName = (pool: string) => {
  const market = MARKETS.find(
    (m) => m.pool.toLowerCase() === pool.toLowerCase(),
  );
  if (!market) return `${pool.slice(0, 6)}…${pool.slice(-4)}`;
  const shared = MARKETS.filter((m) => m.label === market.label).length > 1;
  return shared ? `${market.label} (${market.assetSymbol})` : market.label;
};

const amount = (v: bigint | string) =>
  (Number(v) / 1e6).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/**
 * Newest first.
 *
 * `fromBlock` is the factory's own deployment block: nothing can predate the contract that creates
 * these accounts, so it is exact rather than a guess, and it saves scanning the 485 million blocks
 * before it.
 */
export async function readAccountActivity(
  client: PublicClient,
  account: Address,
  fromBlock = 502_979_401n,
): Promise<AccountEvent[]> {
  const served = await fromBackend(account);
  if (served) return served;
  return readFromChain(client, account, fromBlock);
}

/** The shape `GET /api/activity` returns: the fields of the events, not sentences about them. */
type ServedEvent = {
  block: number;
  blockTime?: number;
  logIndex: number;
  kind: "moved" | "agent" | "venue" | "in" | "out" | "unknown";
  tx: string;
  pool?: string;
  amount?: string;
  supplied?: boolean;
  allowed?: boolean;
  agent?: string;
};

/**
 * Null rather than throwing, because a backend that is down is a reason to read the chain, not a
 * reason to show a person an error about a service they did not know existed.
 */
async function fromBackend(account: Address): Promise<AccountEvent[] | null> {
  try {
    const res = await fetch(
      `${API_BASE}/api/activity?account=${account.toLowerCase()}`,
      { headers: { accept: "application/json" } },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { events?: ServedEvent[] };
    if (!Array.isArray(body.events)) return null;
    return body.events.map((e) => ({
      kind: e.kind,
      units: BigInt(e.amount ?? "0"),
      into: e.kind === "out" ? false : Boolean(e.supplied),
      key: `${e.block}-${e.logIndex}`,
      what: sentence(e),
      amount: carriesMoney(e.kind) ? `${amount(e.amount ?? "0")} USDC` : "",
      where: e.pool ? marketName(e.pool) : "",
      block: BigInt(e.block),
      at: e.blockTime ? e.blockTime : null,
      tx: e.tx as `0x${string}`,
    }));
  } catch {
    return null;
  }
}

const carriesMoney = (kind: ServedEvent["kind"]) =>
  kind === "moved" || kind === "in" || kind === "out";

/**
 * The English, composed here in both paths.
 *
 * The backend returns fields and no prose on purpose: a second set of sentences in Go, free to
 * drift from these, is the thing `graph.go` refuses for the same reason.
 */
function sentence(e: ServedEvent): string {
  switch (e.kind) {
    case "moved":
      // The amount and the market have columns of their own, so the sentence says the verb.
      return e.supplied ? "Put money to work" : "Took money back out";
    case "agent":
      return e.agent === "0x0000000000000000000000000000000000000000"
        ? "Took the agent's permission away"
        : "Named the agent that may move capital";
    case "venue":
      return e.allowed ? "Allowed a market" : "Revoked a market";
    case "in":
      return "Money in";
    case "out":
      return "Money out";
    default:
      return "Something happened on this account";
  }
}

async function readFromChain(
  client: PublicClient,
  account: Address,
  fromBlock: bigint,
): Promise<AccountEvent[]> {
  const [moved, agent, venue] = await Promise.all([
    client.getLogs({ address: account, event: MOVED, fromBlock }),
    client.getLogs({ address: account, event: AGENT, fromBlock }),
    client.getLogs({ address: account, event: VENUE, fromBlock }),
  ]);

  const rows: AccountEvent[] = [
    ...moved.map((l) => ({
      kind: "moved" as const,
      units: l.args.amount ?? 0n,
      into: Boolean(l.args.supplied),
      key: `${l.blockNumber}-${l.logIndex}`,
      what: l.args.supplied ? "Put money to work" : "Took money back out",
      amount: `${amount(l.args.amount ?? 0n)} USDC`,
      where: marketName(String(l.args.pool)),
      block: l.blockNumber ?? 0n,
      // The fallback has no timestamp: `eth_getLogs` does not carry one and fetching a header per
      // block from a browser is the cost this whole path exists to avoid. No date beats a wrong one.
      at: null,
      tx: l.transactionHash as `0x${string}`,
    })),
    ...agent.map((l) => ({
      kind: "agent" as const,
      units: 0n,
      into: false,
      key: `${l.blockNumber}-${l.logIndex}`,
      what:
        String(l.args.agent) === "0x0000000000000000000000000000000000000000"
          ? "Took the agent's permission away"
          : "Named the agent that may move capital",
      amount: "",
      where: "",
      block: l.blockNumber ?? 0n,
      at: null,
      tx: l.transactionHash as `0x${string}`,
    })),
    ...venue.map((l) => ({
      kind: "venue" as const,
      units: 0n,
      into: false,
      key: `${l.blockNumber}-${l.logIndex}`,
      what: l.args.allowed ? "Allowed a market" : "Revoked a market",
      amount: "",
      where: marketName(String(l.args.pool)),
      block: l.blockNumber ?? 0n,
      at: null,
      tx: l.transactionHash as `0x${string}`,
    })),
  ];

  return rows.sort((a, b) =>
    a.block === b.block
      ? b.key.localeCompare(a.key)
      : Number(b.block - a.block),
  );
}

/**
 * The same history with the mechanical halves taken out, for a list a person reads.
 *
 * Supplying to a market is one transaction that emits two things: `IdleCapitalMoved`, which says
 * what happened, and the token transfer that carries it out. Both are needed to work out what the
 * account is worth — one moves the working side, the other the liquid side — and showing both reads
 * as the money leaving twice.
 *
 * The pairing is by transaction and figure rather than by counterparty, because the counterparty is
 * not reliably a market's own address: Aave pulls to its receipt token, not to the pool the event
 * names. A transfer matched by neither stays, which is the case that matters — that is the owner
 * funding the account, or taking it back.
 */
export function withoutVenueLegs(events: AccountEvent[]): AccountEvent[] {
  const legs = new Set(
    events.filter((e) => e.kind === "moved").map((e) => `${e.tx}-${e.units}`),
  );
  return events.filter(
    (e) =>
      (e.kind !== "in" && e.kind !== "out") || !legs.has(`${e.tx}-${e.units}`),
  );
}

/**
 * Which slice of a list one page is, with the page index clamped into range.
 *
 * **Clamped rather than stored-and-reset.** The activity table's row set shrinks — a wallet
 * disconnects, a query refetches shorter, a subgraph answer comes back empty — and an index kept
 * in state then points past the end. The result is a table with no rows, no error and no
 * explanation, which reads as "nothing ever happened" rather than "you are on page 4 of 1". An
 * effect that watched the length and reset it would be a second source of truth about the same
 * number; deriving it cannot get out of step.
 *
 * `pages` is at least 1 so an empty list has a page rather than zero of them, which is what makes
 * `current` safe to use as an index without a second guard at the call site.
 */
export function pageOf(
  total: number,
  page: number,
  size: number,
): { pages: number; current: number; from: number; count: number } {
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(0, page), pages - 1);
  const from = current * size;
  return {
    pages,
    current,
    from,
    count: Math.max(0, Math.min(size, total - from)),
  };
}
