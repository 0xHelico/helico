"use client";

import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient } from "wagmi";

import {
  ACCOUNT_TOKENS,
  type AccountState,
  configuredFactory,
  readAccount,
} from "@/lib/account";

/** Arbitrum One, which is the only chain this product acts on. */
export const CHAIN_ID = 42161;

/**
 * The account, read once for the whole page.
 *
 * Three components wanted this and two of them had it: the query key is identical, so react-query
 * serves all of them from one read. The third — the summary at the top of the mandate page — did
 * not have it at all, and said "Reading the account…" forever because there was nothing reading.
 */
export function useAccountState() {
  const { address } = useAccount();
  const client = usePublicClient({ chainId: CHAIN_ID });
  const factory = configuredFactory();

  return useQuery<AccountState>({
    enabled: Boolean(client && address),
    queryKey: ["account", factory, address],
    queryFn: async () => {
      if (!(client && address)) throw new Error("no client");
      return readAccount(client, factory, address, ACCOUNT_TOKENS);
    },
  });
}

/** What the account holds, or null when there is nothing read yet. */
export function totals(state: AccountState | undefined) {
  if (!state || state.kind === "unconfigured") return null;
  return {
    total: state.idle + state.working,
    idle: state.idle,
    working: state.working,
  };
}
