"use client";

import type { Address, PublicClient } from "viem";
import { getAddress, isAddress, parseAbi } from "viem";

/** Only what the app reads. The factory has more; a smaller surface is a smaller lie. */
export const factoryAbi = parseAbi([
  "function accountFor(address owner) view returns (address)",
  "function isOpen(address owner) view returns (bool)",
]);

export const accountReadAbi = parseAbi([
  "function agent() view returns (address)",
  "function permittedVenue(address pool) view returns (bool)",
  "function owner() view returns (address)",
]);

const balanceOfAbi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
]);

/**
 * The account factory, or null.
 *
 * Nothing is deployed yet, so null is the ordinary case rather than an error, and every caller
 * has to handle it. That is deliberate: a panel that renders a spinner forever while no contract
 * exists is indistinguishable from one that is broken.
 */
export function configuredFactory(): Address | null {
  const fromEnv = process.env.NEXT_PUBLIC_ACCOUNT_FACTORY;
  return fromEnv && isAddress(fromEnv) ? getAddress(fromEnv) : null;
}

/**
 * What an owner's account is, which has three states that look alike from outside and must not
 * be collapsed into one.
 *
 * `unconfigured` — this build has no factory address, so there is nothing to ask.
 * `unopened` — the factory answers, and the address it names holds no code yet. **This is not an
 *   error and not an empty account.** A `CREATE2` address is knowable before anything is
 *   deployed, so tokens can already have been sent to it; the balances below are read regardless.
 * `open` — there is code at it.
 *
 * An unconfigured app and an unopened account both render as "nothing to show", and conflating
 * them is how a missing environment variable gets read as a user who has not started.
 */
export type AccountState =
  | { kind: "unconfigured" }
  | { kind: "unopened"; address: Address; idle: bigint; working: bigint }
  | {
      kind: "open";
      address: Address;
      idle: bigint;
      working: bigint;
      agent: Address | null;
    };

export type AccountTokens = { idle: Address; working: Address };

/**
 * Read an owner's account.
 *
 * Every read is allowed to fail on its own. A chain that answers the factory but not the aToken
 * should still show the address and the idle balance, because a partial answer that says which
 * part is missing beats one error for the whole panel.
 */
export async function readAccount(
  client: PublicClient,
  factory: Address | null,
  owner: Address,
  tokens: AccountTokens,
): Promise<AccountState> {
  if (!factory) return { kind: "unconfigured" };

  const address = await client.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: "accountFor",
    args: [owner],
  });

  const balance = async (token: Address) => {
    try {
      return await client.readContract({
        address: token,
        abi: balanceOfAbi,
        functionName: "balanceOf",
        args: [address],
      });
    } catch {
      return 0n;
    }
  };
  const [idle, working] = await Promise.all([
    balance(tokens.idle),
    balance(tokens.working),
  ]);

  const code = await client.getCode({ address });
  if (!code || code === "0x") {
    return { kind: "unopened", address, idle, working };
  }

  let agent: Address | null = null;
  try {
    agent = await client.readContract({
      address,
      abi: accountReadAbi,
      functionName: "agent",
    });
  } catch {
    // An account from an older implementation may not answer this. The address and the
    // balances are still true, and they are the part worth showing.
  }
  return { kind: "open", address, idle, working, agent };
}

/** Zero means nobody, and `agent()` returning the zero address is how the account says so. */
export function hasAgent(state: AccountState): boolean {
  return (
    state.kind === "open" &&
    state.agent !== null &&
    state.agent !== "0x0000000000000000000000000000000000000000"
  );
}

/**
 * The share of the account that is earning, in basis points.
 *
 * Returns null rather than zero for an empty account: nothing at work out of nothing is not the
 * same as nothing at work out of ten thousand, and a progress bar that reads 0% for both tells
 * the owner their capital is idle when they have none.
 */
export function workingBps(state: AccountState): number | null {
  if (state.kind === "unconfigured") return null;
  const total = state.idle + state.working;
  if (total === 0n) return null;
  return Number((state.working * 10_000n) / total);
}
