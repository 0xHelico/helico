"use client";

import {
  HELICO_AQUA,
  type MakerMandates,
  makerMandates,
  query,
} from "@helico/plugin-thegraph";

/**
 * What a wallet is allowed to spend through Aqua, which the chain cannot tell you.
 *
 * `_balances` is private and four levels deep — maker, app, strategyHash, token — so nothing
 * enumerates it; `rawBalances` needs a hash you already hold; and not one parameter of Aqua's
 * four events is `indexed`, so logs cannot be filtered by maker either. An indexer is not a
 * faster way to answer this question. It is the only way.
 *
 * The endpoint is a Subgraph Studio deployment: no key, and `access-control-allow-origin: *`, so
 * the browser asks it directly. Nothing here goes through our backend, which means this panel
 * keeps working when everything of ours is down.
 */
export const AQUA_SUBGRAPH = HELICO_AQUA[42161];

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
  const answer: MakerMandates = await makerMandates(AQUA_SUBGRAPH, maker);
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
  const raw = await query<{ movements: { timestamp: string }[] }>(
    AQUA_SUBGRAPH,
    { apiKey: "" },
    MOVEMENTS,
    { maker: maker.toLowerCase(), first: PAGE },
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
 */
const APPS: Record<string, string> = {
  "0xa16d313816247628deb7d89dc7a3cf4adb5287ed": "HelicoMandateSwap",
  "0xb8c9f14d46bf387a6d70d796df30f11a0eb8c3be": "Helico SwapVM",
  "0x111111338c5091e8440b67b168bae16a668ac0de": "1inch SwapVM",
};

export function appName(address: string): string | null {
  return APPS[address.toLowerCase()] ?? null;
}
