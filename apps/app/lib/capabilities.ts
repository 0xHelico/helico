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
 *
 * `wired` moved with it, later than it should have. It sat on "Keep a position in range" — a row
 * whose own sentence says it is *not where the agent is pointed* — so the one live switch on the
 * page drove a capability the product had already left, and after the switch moved to the account
 * it would have been revoking an agent under a heading about Uniswap ranges. The rule this list
 * states about itself is that a row is wired when something answers it today; the row that
 * qualifies is the one the account's agent actually performs.
 */
export const GRANTS: Grant[] = [
  {
    name: "Put idle capital to work",
    glyph: "leaf",
    detail: "Into a market you allowed, and back out again.",
    wired: true,
  },
  {
    name: "Keep a position in range",
    glyph: "arcs",
    detail: "Re-centre a Uniswap v4 range as the price drifts.",
    wired: false,
  },
  {
    name: "Lend and borrow",
    glyph: "bank",
    detail: "Under a health-factor floor the account enforces.",
    wired: false,
  },
  {
    name: "Perpetuals",
    glyph: "bars",
    detail: "Bounded size, and no margin top-ups with your money.",
    wired: false,
  },
  {
    name: "Pay for its own work",
    glyph: "coins",
    detail: "Inference and data, under a daily ceiling.",
    wired: false,
  },
  {
    name: "Move across chains",
    glyph: "layers",
    detail: "To an allow-listed chain, and only to your own address.",
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
