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

/**
 * Authority, held over time. Exactly one is wired to a contract; the rest are the direction.
 *
 * The order changed on 8 September, when CRE moved off re-centring Uniswap v4 ranges and onto
 * the yield layer. The list leads with what the agent is actually built to do now.
 */
export const GRANTS: Grant[] = [
  {
    name: "Put idle capital to work",
    glyph: "leaf",
    detail:
      "Move what is sitting still into a lending market you allow-listed, and take it back out. The agent has no say in where it goes: neither call takes a recipient, so both ends are your own account.",
    wired: false,
  },
  {
    name: "Keep a position in range",
    glyph: "arcs",
    detail:
      "Re-centre a Uniswap v4 range when the price drifts. Built and tested; it is no longer what the agent is pointed at.",
    wired: true,
  },
  {
    name: "Lend and borrow",
    glyph: "bank",
    detail:
      "Supply and borrow under a health-factor floor the account enforces.",
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

/**
 * Sentences that are answered today. Each one happens once, and you sign it.
 *
 * The third is the only one a panel cannot do better. A table can show that nothing moved; only
 * a sentence can say *why* nothing moved, and "180 dollars does not cover its own gas" is the
 * answer people actually want.
 */
export const ASKS: Ask[] = [
  {
    name: "Read the split",
    glyph: "percent",
    say: "How much is working and how much is liquid?",
    detail: "What is earning, what is spendable, and at what rate.",
  },
  {
    name: "Read your mandates",
    glyph: "document",
    say: "What am I allowed to spend?",
    detail:
      "Answered from the subgraph, because the chain cannot list them at all.",
  },
  {
    name: "Ask why it held",
    glyph: "scales",
    say: "Why did you not move anything?",
    detail:
      "The deadband, in words: a move has to beat its own gas and matter against the size of the account.",
  },
];
