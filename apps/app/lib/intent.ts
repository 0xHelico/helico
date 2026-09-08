import type { Address } from "viem";

/** What `apps/be` returns once it has checked a sentence against its token registry. */
export type IntentToken = {
  symbol: string;
  address: Address;
  decimals: number;
  name: string;
};

export type Intent = {
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
 * What a turn produced, as stored on the message.
 *
 * A swap keeps the shape it always had, so conversations written before the chat could do
 * anything else still render. The other actions carry no parameters — there is nothing to check
 * and nothing to sign until the person presses the button — so the name is the whole record.
 */
export type TurnAction = { action: "status" | "revoke" };

export type TurnResult = Intent | TurnAction;

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
  return action === "status" || action === "revoke";
}
