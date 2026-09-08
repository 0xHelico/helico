import type { GlyphName } from "@/components/glyph";

/**
 * Authority the agent holds: something it may do on your behalf while a mandate says so, and
 * which a switch genuinely turns off.
 *
 * There used to be a second kind here — an *ask*, a sentence you said to a chat. It went with
 * the chat, because the product's loop has no human in it: you set the terms once and revoke
 * when you want to stop, and neither of those is a conversation.
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
