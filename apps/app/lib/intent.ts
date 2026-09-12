import type { Address } from "viem";

/** What `apps/be` returns once it has checked a sentence against its token registry. */
export type IntentToken = {
  symbol: string;
  address: Address;
  decimals: number;
  name: string;
};

export type Intent = {
  /** Set instead of `amountInWei` when the sentence named dollars. The card converts it. */
  amountUsd?: string;
  chainId: number;
  chain: string;
  tokenIn: IntentToken;
  tokenOut: IntentToken;
  /** Human amount, as the person said it. */
  amountIn: string;
  /** The same amount in the token's smallest unit, which is what gets signed. */
  amountInWei: string;
};

/**
 * One check `apps/be` ran, named after the function that ran it.
 *
 * These are collected where the work happens rather than composed from the outcome, which is the
 * only reason showing them is worth anything: a tree that says `Chain.Token ✓` is a lookup that
 * returned, and a refusal ends on the check that refused rather than on a sentence about it.
 */
export type Step = { call: string; detail: string; ok: boolean };

/** One panel of an answer the backend chose to draw rather than write out. */
export type Card = {
  title: string;
  body: string;
  try?: string;
  href?: string;
  tags?: string[];
};

/**
 * What a turn produced, as stored on the message.
 *
 * A swap keeps the shape it always had, so conversations written before the chat could do
 * anything else still render. The other actions carry no parameters — there is nothing to check
 * and nothing to sign until the person presses the button — so the name is the whole record.
 *
 * Steps ride along on whichever of those it is, and on neither when the turn only asked a
 * question. They go in this field rather than in a column of their own so that a reloaded
 * conversation redraws the same tree, which is what `chat.Message` already promises about the
 * rest of the turn. Cards travel the same way and for the same reason: an answer drawn as four
 * panels should still be four panels after a reload, not the paragraph it replaced.
 */
export type TurnAction = {
  action: "status" | "revoke" | "withdraw" | "earn" | "deposit" | "provide";
  /**
   * For "earn" only: a swap the sentence asked for first — "swap $1 of ETH to USDC and put it all
   * to work" — checked by the backend like any swap. The put-to-work card carries it in the same
   * batch as the ship, with the account as the swap's receiver.
   */
  fund?: Intent;
};

type Extras = { steps?: Step[]; cards?: Card[] };

export type TurnResult = (Intent & Extras) | (TurnAction & Extras) | Extras;

/** A swap is the one with a chain on it. Nothing else the backend returns has one. */
export function isIntent(value: unknown): value is Intent {
  return typeof value === "object" && value !== null && "chainId" in value;
}

/** And an action is the one that names itself. */
export function isTurnAction(value: unknown): value is TurnAction {
  if (typeof value !== "object" || value === null || !("action" in value)) {
    return false;
  }
  const { action } = value as { action: unknown };
  return (
    action === "status" ||
    action === "revoke" ||
    action === "withdraw" ||
    action === "earn" ||
    action === "deposit" ||
    action === "provide"
  );
}

/**
 * How much the wallet is short of the amount it is trying to swap, or null when it can cover it.
 *
 * Its own function because it decides whether a transaction is offered at all, and a swap sent
 * short does not fail politely: it reverts, and the person pays the gas to find out.
 */
export function shortfall(
  balance: bigint | undefined,
  amountIn: bigint,
): bigint | null {
  if (balance === undefined) return null;
  return balance < amountIn ? amountIn - balance : null;
}
