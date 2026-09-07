/**
 * What the agent may be asked to do, and what it may not yet.
 *
 * Every row here is either **wired** — meaning something in this repository answers it today and
 * a test proves it — or **not**, and the difference is rendered rather than described. A row that
 * looked available and did nothing would be the one kind of mistake that costs the whole
 * submission rather than a mark, so the list is checked against the code and not against the
 * roadmap.
 *
 * Adding a capability means wiring it first and moving it here second. `docs/plans` and the
 * design in #142 are where intentions live; this file is only for what runs.
 */
export type Capability = {
  name: string;
  /** What a person would say to ask for it. Wired rows send this to the composer. */
  say: string;
  detail: string;
  /** True only when something in this repository answers it today. */
  wired: boolean;
};

export const CAPABILITIES: Capability[] = [
  {
    name: "Keep a position in range",
    say: "What is my position doing?",
    detail:
      "The agent re-centres your Uniswap v4 range when the price drifts, inside the limits below. It decides in an enclave and the vault refuses anything outside them.",
    wired: true,
  },
  {
    name: "Swap",
    say: "Swap half an ETH into USDC",
    detail:
      "Priced against what your wallet actually holds. Nothing moves until you sign it.",
    wired: true,
  },
  {
    name: "End the mandate",
    say: "Revoke my mandate",
    detail:
      "Needs nobody's permission, and works while the contract is paused, while the agent is gone, and while an upgrade is pending.",
    wired: true,
  },
  {
    name: "Lend and borrow",
    say: "",
    detail: "Supply and borrow under a health-factor floor the vault enforces.",
    wired: false,
  },
  {
    name: "Earn and yield",
    say: "",
    detail: "Enter a yield position whose maturity cannot outlast the mandate.",
    wired: false,
  },
  {
    name: "Perpetuals",
    say: "",
    detail:
      "Bounded leverage and size, and no margin top-ups — so a losing position cannot be defended with your money.",
    wired: false,
  },
  {
    name: "Pay for its own work",
    say: "",
    detail:
      "Machine-to-machine payment for inference and data, under a daily ceiling.",
    wired: false,
  },
  {
    name: "Move across chains",
    say: "",
    detail:
      "Bridge to an allow-listed destination, and only to your own address.",
    wired: false,
  },
];

export const wired = CAPABILITIES.filter((c) => c.wired);
export const notWired = CAPABILITIES.filter((c) => !c.wired);
