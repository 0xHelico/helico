"use client";

import { vaultAbi } from "@helico/plugin-cre/abi";
import { addresses } from "@helico/plugin-uniswap";
import type { Address, PublicClient } from "viem";
import { getAddress, isAddress } from "viem";

export { vaultAbi };

const KEY = "helico.vault";

/**
 * Helico's vault on Arbitrum One.
 *
 * The address is not compiled in. It arrives either from the build (`NEXT_PUBLIC_VAULT_ADDRESS`)
 * or from whoever pastes it into the mandate page, and the pasted one wins — a deployment should
 * not need a rebuild of this app to become usable, and a judge should be able to point it at one
 * without touching the repository.
 */
export function configuredVault(): Address | null {
  const fromEnv = process.env.NEXT_PUBLIC_VAULT_ADDRESS;
  if (typeof window === "undefined") {
    return fromEnv && isAddress(fromEnv) ? getAddress(fromEnv) : null;
  }
  try {
    const saved = window.localStorage.getItem(KEY);
    if (saved && isAddress(saved)) {
      return getAddress(saved);
    }
  } catch {
    // Private windows and blocked storage both land here; the build's value still applies.
  }
  return fromEnv && isAddress(fromEnv) ? getAddress(fromEnv) : null;
}

export function rememberVault(address: Address | null) {
  try {
    if (address) {
      window.localStorage.setItem(KEY, getAddress(address));
    } else {
      window.localStorage.removeItem(KEY);
    }
  } catch {
    // Nothing to do: the page keeps working, it just will not remember.
  }
}

export type VaultCheck =
  | { ok: true; positionManager: Address }
  | { ok: false; reason: string };

/**
 * Is this address a Helico vault, on this chain's real Uniswap deployment?
 *
 * Reading the three addresses it was initialised with and comparing them to the ones the plugin
 * resolves is what separates "someone typed an address" from "this is the contract". It catches
 * the mistakes that actually happen: a testnet address on mainnet, a proxy that is something
 * else, an EOA, a typo. Nothing here trusts the input.
 */
export async function checkVault(
  client: PublicClient,
  address: Address,
  chainId: number,
): Promise<VaultCheck> {
  const code = await client.getCode({ address });
  if (!code || code === "0x") {
    return { ok: false, reason: "Nothing is deployed at that address." };
  }

  let expected: ReturnType<typeof addresses>;
  try {
    expected = addresses(chainId);
  } catch {
    return {
      ok: false,
      reason: `Uniswap v4 is not known on chain ${chainId}.`,
    };
  }

  const read = (
    functionName: "positionManager" | "stateView" | "poolManager",
  ) => client.readContract({ abi: vaultAbi, address, functionName });

  let got: [Address, Address, Address];
  try {
    got = (await Promise.all([
      read("positionManager"),
      read("stateView"),
      read("poolManager"),
    ])) as [Address, Address, Address];
  } catch {
    return {
      ok: false,
      reason:
        "That contract does not answer like a Helico vault — it has no positionManager, stateView or poolManager.",
    };
  }

  const want: [Address, Address, Address] = [
    expected.positionManager,
    expected.stateView,
    expected.poolManager,
  ];
  const names = ["position manager", "state view", "pool manager"] as const;
  for (let i = 0; i < 3; i++) {
    if (got[i].toLowerCase() !== want[i].toLowerCase()) {
      return {
        ok: false,
        reason: `Its ${names[i]} is ${got[i]}, but this chain's is ${want[i]}. That vault belongs to a different deployment.`,
      };
    }
  }
  return { ok: true, positionManager: got[0] };
}

/** Sensible starting terms. Every one of them is the user's to change before signing. */
export const MANDATE_DEFAULTS = {
  rangeWidthTicks: 1000,
  minImprovementBps: 50,
  cooldownSeconds: 3600,
  expiryDays: 30,
  minRetainedBps: 9000,
} as const;

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
  if (balance === undefined) {
    return null;
  }
  return balance < amountIn ? amountIn - balance : null;
}
