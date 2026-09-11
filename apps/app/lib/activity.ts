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
  /** Block first, log index second. Two events in one transaction keep the order they happened. */
  key: string;
  what: string;
  block: bigint;
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

const amount = (v: bigint) =>
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
  logIndex: number;
  kind: "moved" | "agent" | "venue" | "unknown";
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
      key: `${e.block}-${e.logIndex}`,
      what: sentence(e),
      block: BigInt(e.block),
      tx: e.tx as `0x${string}`,
    }));
  } catch {
    return null;
  }
}

/**
 * The English, composed here in both paths.
 *
 * The backend returns fields and no prose on purpose: a second set of sentences in Go, free to
 * drift from these, is the thing `graph.go` refuses for the same reason.
 */
function sentence(e: ServedEvent): string {
  const amount = (v: string) =>
    (Number(v) / 1e6).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  switch (e.kind) {
    case "moved":
      return e.supplied
        ? `Put ${amount(e.amount ?? "0")} USDC to work in ${marketName(e.pool ?? "")}`
        : `Took ${amount(e.amount ?? "0")} USDC back out of ${marketName(e.pool ?? "")}`;
    case "agent":
      return e.agent === "0x0000000000000000000000000000000000000000"
        ? "Took the agent's permission away"
        : "Named the agent that may move capital";
    case "venue":
      return `${e.allowed ? "Allowed" : "Revoked"} ${marketName(e.pool ?? "")}`;
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
      key: `${l.blockNumber}-${l.logIndex}`,
      what: l.args.supplied
        ? `Put ${amount(l.args.amount ?? 0n)} USDC to work in ${marketName(String(l.args.pool))}`
        : `Took ${amount(l.args.amount ?? 0n)} USDC back out of ${marketName(String(l.args.pool))}`,
      block: l.blockNumber ?? 0n,
      tx: l.transactionHash as `0x${string}`,
    })),
    ...agent.map((l) => ({
      key: `${l.blockNumber}-${l.logIndex}`,
      what:
        String(l.args.agent) === "0x0000000000000000000000000000000000000000"
          ? "Took the agent's permission away"
          : "Named the agent that may move capital",
      block: l.blockNumber ?? 0n,
      tx: l.transactionHash as `0x${string}`,
    })),
    ...venue.map((l) => ({
      key: `${l.blockNumber}-${l.logIndex}`,
      what: `${l.args.allowed ? "Allowed" : "Revoked"} ${marketName(String(l.args.pool))}`,
      block: l.blockNumber ?? 0n,
      tx: l.transactionHash as `0x${string}`,
    })),
  ];

  return rows.sort((a, b) =>
    a.block === b.block
      ? b.key.localeCompare(a.key)
      : Number(b.block - a.block),
  );
}
