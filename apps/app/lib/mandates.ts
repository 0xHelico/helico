"use client";

import {
  ARBITRUM_ONE,
  mandateSwapAddress,
  swapVmAddress,
} from "@helico/plugin-1inch";
import {
  HELICO_AQUA,
  type MakerMandates,
  makerMandates,
  query,
  type Subgraph,
} from "@helico/plugin-thegraph";

import { API_BASE } from "@/lib/api";

/**
 * What a wallet is allowed to spend through Aqua, which the chain cannot tell you.
 *
 * `_balances` is private and four levels deep — maker, app, strategyHash, token — so nothing
 * enumerates it; `rawBalances` needs a hash you already hold; and not one parameter of Aqua's
 * four events is `indexed`, so logs cannot be filtered by maker either. An indexer is not a
 * faster way to answer this question. It is the only way.
 *
 * The endpoint is a Subgraph Studio deployment: no key, and `access-control-allow-origin: *`, so
 * the browser can ask it directly — and does, whenever our own cache is not there.
 */
export const AQUA_SUBGRAPH = HELICO_AQUA[42161];

/**
 * The same subgraph, through our cache.
 *
 * Studio's free tier is metered per month, and every visitor asking the same two questions on
 * every page load spends it on answers we already had. The backend forwards the identical
 * `{query, variables}` body and returns the subgraph's own JSON, so this is a URL swap and
 * nothing more — the queries stay in `@helico/plugin-thegraph`, which is what the submission
 * points at, and the backend never learns the schema.
 */
const CACHED: Subgraph = { ...AQUA_SUBGRAPH, url: `${API_BASE}/api/graph` };

/**
 * Ask the cache; ask Studio if the cache does not answer.
 *
 * This is what keeps the old property. Reading straight from Studio meant these panels worked
 * when everything of ours was down, and routing them through our backend would have quietly
 * traded that away for a smaller bill. Now the backend is an optimisation: when it is missing,
 * slow, or refusing, the page is exactly as good as it was before it existed.
 *
 * Exported so the Aqua swap planner reaches the index the same way. A second copy of the
 * fallback would eventually keep only one of the two properties it exists for.
 */
export async function askGraph<T>(
  ask: (subgraph: Subgraph) => Promise<T>,
): Promise<T> {
  try {
    return await ask(CACHED);
  } catch {
    return await ask(AQUA_SUBGRAPH);
  }
}

export type MandateRow = {
  strategyHash: string;
  app: string;
  active: boolean;
  movements: number;
  balances: { token: string; amount: bigint; spendable: boolean }[];
};

export type MandateView = {
  maker: string;
  rows: MandateRow[];
  active: number;
  /** Token address to the total still spendable across every live mandate. */
  spendable: Map<string, bigint>;
};

export async function readMandates(maker: string): Promise<MandateView> {
  const answer: MakerMandates = await askGraph((s) => makerMandates(s, maker));
  return {
    maker: answer.maker,
    rows: answer.mandates.map((m) => ({
      strategyHash: m.strategyHash,
      app: m.app,
      active: m.active,
      movements: m.movementCount,
      balances: m.balances.map((b) => ({
        token: b.token,
        amount: b.amount,
        spendable: b.spendable,
      })),
    })),
    active: answer.active,
    spendable: answer.spendable,
  };
}

/**
 * Has this maker already shipped a live position to one particular app?
 *
 * **Why this is a function and not three lines inside the card.** The card that ships used to
 * answer it from `useSendCalls` state, which belongs to one press — so a reload showed a fresh
 * `Execute` over a position that already existed, and pressing it shipped a *second* mandate
 * under a new salt. The answer has to come from outside the session, and the two ways to get it
 * wrong are worth a test each: counting a mandate on a different app, and counting one that is
 * no longer active.
 *
 * `active` is Aqua's own flag as the subgraph carries it — a docked mandate and an expired one
 * are both gone, and a card that ticked on either would report work that no longer exists.
 */
export function shipped(
  rows: MandateRow[],
  app: string,
): { count: number; hash?: string } {
  const want = app.toLowerCase();
  const mine = rows.filter((r) => r.active && r.app.toLowerCase() === want);
  return { count: mine.length, hash: mine[0]?.strategyHash };
}

/**
 * Tokens the app can name. Anything else is shown as its address rather than guessed at — a
 * wrong symbol beside a real balance is worse than an address nobody recognises.
 */
const KNOWN: Record<string, { symbol: string; decimals: number }> = {
  "0xaf88d065e77c8cc2239327c5edb3a432268e5831": { symbol: "USDC", decimals: 6 },
  "0x82af49447d8a07e3bd95bd0d56f35241523fbab1": {
    symbol: "WETH",
    decimals: 18,
  },
  "0x912ce59144191c1204e64559fe8253a0e49e6548": { symbol: "ARB", decimals: 18 },
  "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1": { symbol: "DAI", decimals: 18 },
  "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9": { symbol: "USDT", decimals: 6 },
  "0x724dc807b04555b71ed48a6896b6f41593b8c637": {
    symbol: "aUSDC",
    decimals: 6,
  },
};

/**
 * The ERC-20s this app can name, for reading a wallet rather than the account.
 *
 * The same table `token()` answers from, exposed as a list because a balance read needs to
 * iterate it. `aUSDC` is in it deliberately: after an escape the receipt sits in the wallet, and
 * a list that could not name it would show the owner an address instead of their own money.
 */
export const WALLET_TOKENS = KNOWN;

export function token(address: string): {
  symbol: string;
  decimals: number | null;
} {
  const known = KNOWN[address.toLowerCase()];
  if (known) return known;
  return {
    symbol: `${address.slice(0, 6)}…${address.slice(-4)}`,
    decimals: null,
  };
}

/**
 * An amount, or the raw integer when the token's decimals are unknown.
 *
 * Guessing 18 is the tempting shortcut and it is wrong by six orders of magnitude on USDC. An
 * unformatted integer reads as unfinished; a confidently mis-scaled one reads as true.
 */
export function amount(value: bigint, decimals: number | null): string {
  if (decimals === null) return value.toString();
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const rest = value % base;
  if (rest === 0n) return whole.toLocaleString();
  const frac = rest
    .toString()
    .padStart(decimals, "0")
    .slice(0, 2)
    .replace(/0+$/, "");
  return frac ? `${whole.toLocaleString()}.${frac}` : whole.toLocaleString();
}

/**
 * When this wallet's mandates were actually used, one timestamp per movement.
 *
 * Scoped with a nested filter on the mandate's maker rather than fetched and thrown away
 * client-side: the top-level list is every movement on the chain, and paging through it to find
 * one wallet's would be reading a thousand rows to keep a hundred.
 *
 * Capped at a page. A wallet past that reads as busier than the chart can draw, which is the
 * right way for this to be wrong — the caption says so.
 */
const MOVEMENTS = `
  query Movements($maker: Bytes!, $first: Int!) {
    movements(
      where: { mandate_: { maker: $maker } }
      orderBy: timestamp
      orderDirection: asc
      first: $first
    ) {
      timestamp
    }
  }
`;

const PAGE = 1000;

export async function readMovements(
  maker: string,
): Promise<{ timestamps: number[]; capped: boolean }> {
  const raw = await askGraph((subgraph) =>
    query<{ movements: { timestamp: string }[] }>(
      subgraph,
      { apiKey: "" },
      MOVEMENTS,
      { maker: maker.toLowerCase(), first: PAGE },
    ),
  );
  return {
    timestamps: raw.movements.map((m) => Number(m.timestamp)),
    capped: raw.movements.length === PAGE,
  };
}

/**
 * Aqua apps this repository can name.
 *
 * Two of them are ours and one is 1inch's, and the table says which without the reader having to
 * recognise a hex prefix. Anything else stays an address: a wrong name beside a real balance is
 * the mistake this file avoids everywhere else.
 *
 * **`HelicoMandateSwap` is asked for rather than written down, and that is the whole point.** It
 * used to be the literal `0xa16d3138…`, which is an address that appears nowhere in
 * `docs/deployments.md` — the app went behind a proxy on 10 September and this copy stayed on the
 * one before it. The live mandate shipped on 12 September therefore rendered as a hex prefix in
 * the panel whose entire job is naming it. An address with a source should be read from the
 * source; `@helico/plugin-1inch` is the source, and it is the same call the card that ships makes.
 */
const APPS: Record<string, string> = {
  [mandateSwapAddress(ARBITRUM_ONE).toLowerCase()]: "HelicoMandateSwap",
  // Ours, and no package holds it: `swapVmAddress` reads 1inch's own router out of their SDK, so
  // there is nothing to derive our deployment from. Checked against `docs/deployments.md`.
  "0xb8c9f14d46bf387a6d70d796df30f11a0eb8c3be": "Helico SwapVM",
  [swapVmAddress(ARBITRUM_ONE).toLowerCase()]: "1inch SwapVM",
};

export function appName(address: string): string | null {
  return APPS[address.toLowerCase()] ?? null;
}
