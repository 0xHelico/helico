"use client";

import { type Address, type PublicClient, parseAbiItem } from "viem";

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
