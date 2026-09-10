"use client";

import type { Address, PublicClient } from "viem";
import { getAddress, isAddress, parseAbi } from "viem";

import { readVenues, suppliedIn } from "./venues";

/**
 * Only what the app calls. The factory has more; a smaller surface is a smaller lie.
 *
 * `open` is the one write. It has no access control on chain — anyone may open an account for
 * anyone, and a second call returns the same address rather than reverting — so the button that
 * sends it needs no permission of its own, and a double click costs gas rather than correctness.
 */
export const factoryAbi = parseAbi([
  "function accountFor(address owner) view returns (address)",
  "function isOpen(address owner) view returns (bool)",
  "function open(address owner) returns (address)",
]);

export const accountReadAbi = parseAbi([
  "function agent() view returns (address)",
  "function permittedVenue(address pool) view returns (bool)",
  "function owner() view returns (address)",
]);

/**
 * The two limits an owner actually sets, and both are owner-only on chain.
 *
 * `setAgent` names who may move idle capital; `permitVenue` names where it may go. Together they
 * are the whole of the agent's reach — `supplyIdle` is gated on `permittedVenue`, `withdrawIdle`
 * on `venueEverPermitted`, and neither takes a recipient. Nothing else the agent can call moves a
 * token.
 */
export const accountWriteAbi = parseAbi([
  "function setAgent(address agent_)",
  "function permitVenue(address pool, bool allowed)",
  // On the proxy rather than the implementation, which is the whole point of it: code may be
  // replaced entirely, this path may not. There is no recipient parameter — the destination is
  // the owner address fixed at construction — so there is no version of this call that sends
  // anywhere else, and nothing an upgrade could do would add one.
  "function escape(address[] tokens)",
]);

/**
 * The agent the deployed workflow signs as, and the market it is configured to use.
 *
 * Both are public addresses rather than configuration: the agent's is in the deploy runbook and
 * on chain in every authorisation it has ever signed, and the pool is Aave v3's on Arbitrum One.
 * A page that made the owner paste either of them would be asking for the one mistake — a
 * mistyped agent — that this contract cannot take back for them.
 */
export const HELICO_AGENT =
  "0x84C3891a9693c891877aC474a90d17d29075fcAf" as const;
export const AAVE_V3_POOL =
  "0x794a61358D6845594F94dc1DB02A252b5b4814aD" as const;

const balanceOfAbi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
]);

/**
 * `HelicoAccountFactory` on Arbitrum One, deployed 8 September.
 *
 * A default in code rather than a required environment variable, for the same reason as the
 * subgraph's URL: a deployed address is public, and a judge who clones this repository should
 * get a working page without being told to configure one. `NEXT_PUBLIC_ACCOUNT_FACTORY`
 * overrides it — set it to an empty string to exercise the not-deployed path, which is still
 * reachable and still rendered.
 */
const DEPLOYED = "0x01CC7d9FE8da79B61bcc5d3f7e3f0433DCE7E081";

/**
 * The account factory, or null.
 *
 * Null is no longer the ordinary case, and the code that handles it stays anyway. A chain the
 * app has no factory for is a real state — another network, an override cleared — and a panel
 * that spins forever in it is indistinguishable from one that is broken.
 */
export function configuredFactory(): Address | null {
  const fromEnv = process.env.NEXT_PUBLIC_ACCOUNT_FACTORY ?? DEPLOYED;
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
 * Arbitrum One. The idle side is what a swap is paid from; the working side is what the same asset
 * is worth wherever it has been put to work — which is why they are one asset in two states rather
 * than two assets.
 *
 * `working` names Aave's receipt only as the fallback for an account with no code yet. For an open
 * account the working side is summed across every market its owner has permitted, because capital
 * the enclave moved to Compound is still the owner's and a panel that showed it as zero would be
 * telling them their money is idle at the moment it started earning more.
 */
export const ACCOUNT_TOKENS: AccountTokens = {
  idle: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  working: "0x724dc807b04555b71ed48a6896b6F41593b8C637",
};

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

  // An open account is asked where its capital actually is, rather than assumed to keep it in the
  // one market this file used to name.
  //
  // **Never below the reading it replaces.** `tokens.working` is read directly above, so it is a
  // floor on what is at work; the venue sweep should include the same position and usually more.
  // Taking the larger is what makes a failure harmless — a venue that will not answer returns no
  // position rather than throwing, so an empty result and an account with nothing at work look
  // identical from here, and the difference matters in the direction that tells an owner their
  // money is idle at the moment it started earning.
  let atWork = working;
  try {
    const { positions } = await readVenues(client, address, [tokens.idle]);
    const across = suppliedIn(positions, tokens.idle);
    if (across > atWork) atWork = across;
  } catch {
    // Keep the single-market reading.
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
  return { kind: "open", address, idle, working: atWork, agent };
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
