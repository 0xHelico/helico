"use client";

import { useQuery } from "@tanstack/react-query";
import { type Address, erc20Abi, formatUnits } from "viem";
import { usePublicClient } from "wagmi";

import { CHAIN_ID } from "@/hooks/use-account-state";
import { priceUsd } from "@/lib/usd";
import { readVenues } from "@/lib/venues";

export const WETH: Address = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";

export type WethHeld = {
  idle: bigint;
  working: bigint;
  total: bigint;
  /** ETH/USD from Chainlink, the feed the swap card sizes dollars with. */
  price: number;
  /** The whole WETH side in USDC micro-units, so it adds to the USDC figures without a float. */
  usdcUnits: bigint;
  /** The market holding the working part, when there is one. */
  pool?: Address;
};

/**
 * The account's WETH side, priced.
 *
 * **The rest of the page was built USDC-first.** `useAccountState` totals USDC and its receipts,
 * the value history is USDC transfers, and the holdings rows formatted everything as six-decimal
 * USDC — so an ether position would have printed as a twelve-digit dollar figure. This is the
 * second asset's read: the account's WETH balance, its WETH venue positions, and the Chainlink
 * price that turns them into the dollars the page is denominated in. Null while nothing is held,
 * so a USDC-only account renders exactly as before.
 */
export function useWethHeld(account: Address | null | undefined) {
  const client = usePublicClient({ chainId: CHAIN_ID });
  return useQuery({
    enabled: Boolean(account && client),
    queryKey: ["weth-held", account],
    staleTime: 30_000,
    retry: false,
    queryFn: async (): Promise<WethHeld | null> => {
      const c = client as NonNullable<typeof client>;
      const a = account as Address;
      const [idle, venues] = await Promise.all([
        c.readContract({
          abi: erc20Abi,
          address: WETH,
          args: [a],
          functionName: "balanceOf",
        }),
        readVenues(c, a, [WETH]),
      ]);
      const at = venues.positions.filter(
        (p) => p.asset.toLowerCase() === WETH.toLowerCase() && p.supplied > 0n,
      );
      const working = at.reduce((s, p) => s + p.supplied, 0n);
      const total = idle + working;
      if (total === 0n) return null;
      const price = await priceUsd(c, WETH);
      const usdcUnits = BigInt(
        Math.round(Number(formatUnits(total, 18)) * price * 1_000_000),
      );
      return { idle, working, total, price, usdcUnits, pool: at[0]?.pool };
    },
  });
}
