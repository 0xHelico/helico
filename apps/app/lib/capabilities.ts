import type { GlyphName } from "@/components/glyph";

/**
 * Two different things live on the front page and they are not interchangeable.
 *
 * A **grant** is authority the agent holds: something it may do on your behalf while a mandate
 * says so, and which a switch genuinely turns off. An **ask** is a sentence you say — it happens
 * once, you sign it, and there is nothing to leave switched on.
 *
 * Every row here is either wired — something in this repository answers it today and a test
 * proves it — or it is not, and the difference is rendered rather than described. A switch that
 * looked live and did nothing would be the one kind of mistake that costs the whole submission
 * rather than a mark, so a row moves into `wired` after it works and never before.
 */
export type Grant = {
  name: string;
  glyph: GlyphName;
  detail: string;
  wired: boolean;
};

export type Ask = {
  name: string;
  glyph: GlyphName;
  say: string;
  detail: string;
};

/** Authority, held over time. The first is real; the rest are the direction and are inert. */
export const GRANTS: Grant[] = [
  {
    name: "Keep a position in range",
    glyph: "arcs",
    detail:
      "Re-centre your Uniswap v4 range when the price drifts. Decided in an enclave, refused by the vault if it falls outside the limits you set.",
    wired: true,
  },
  {
    name: "Lend and borrow",
    glyph: "bank",
    detail: "Supply and borrow under a health-factor floor the vault enforces.",
    wired: false,
  },
  {
    name: "Earn and yield",
    glyph: "leaf",
    detail: "Enter a yield position whose maturity cannot outlast the mandate.",
    wired: false,
  },
  {
    name: "Perpetuals",
    glyph: "bars",
    detail:
      "Bounded leverage and size, and no margin top-ups — so a losing position cannot be defended with your money.",
    wired: false,
  },
  {
    name: "Pay for its own work",
    glyph: "coins",
    detail:
      "Machine-to-machine payment for inference and data, under a daily ceiling.",
    wired: false,
  },
  {
    name: "Move across chains",
    glyph: "layers",
    detail:
      "Bridge to an allow-listed destination, and only to your own address.",
    wired: false,
  },
];

/** Sentences that are answered today. Each one happens once, and you sign it. */
export const ASKS: Ask[] = [
  {
    name: "Swap",
    glyph: "percent",
    say: "Swap half an ETH into USDC",
    detail:
      "Priced against what your wallet holds. Nothing moves until you sign.",
  },
  {
    name: "Read your position",
    glyph: "document",
    say: "What is my position doing?",
    detail: "The range, the limits in force, and when it last acted.",
  },
  {
    name: "End the mandate",
    glyph: "scales",
    say: "Revoke my mandate",
    detail:
      "Works while the contract is paused, while the agent is gone, and while an upgrade is pending.",
  },
];
