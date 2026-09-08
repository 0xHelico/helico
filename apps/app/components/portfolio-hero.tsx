"use client";

import { useQuery } from "@tanstack/react-query";
import { formatUnits } from "viem";
import { useAccount, usePublicClient } from "wagmi";

import { Glyph } from "@/components/glyph";
import { Card } from "@/components/kit";
import {
  type AccountState,
  configuredFactory,
  readAccount,
} from "@/lib/account";

const CHAIN_ID = 42161;
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const;
const AUSDC = "0x724dc807b04555b71ed48a6896b6F41593b8C637" as const;

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const usdc = (v: bigint) =>
  Number(formatUnits(v, 6)).toLocaleString(undefined, {
    maximumFractionDigits: 2,
  });

/**
 * The one number, and who it belongs to.
 *
 * It is a dash rather than `$0.00` while nothing is deployed. Zero is a measurement — it says an
 * account was read and found empty — and there is no account to read. The line under it says
 * which of the two this is, because they look identical otherwise.
 */
export function PortfolioHero() {
  const { address, isConnected } = useAccount();
  const client = usePublicClient({ chainId: CHAIN_ID });
  const factory = configuredFactory();

  const { data } = useQuery<AccountState>({
    enabled: Boolean(client && address),
    queryKey: ["account", factory, address],
    queryFn: async () => {
      if (!(client && address)) throw new Error("no client");
      return readAccount(client, factory, address, {
        idle: USDC,
        working: AUSDC,
      });
    },
  });

  const totals =
    data && data.kind !== "unconfigured"
      ? {
          total: data.idle + data.working,
          idle: data.idle,
          working: data.working,
        }
      : null;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 py-6">
        <div className="flex items-center gap-3">
          <Glyph name="bank" size={32} />
          <h1 className="font-medium text-[19px] text-ink tracking-tight">
            {isConnected && address ? (
              <>
                Welcome, <span className="font-mono">{short(address)}</span>
              </>
            ) : (
              "Portfolio"
            )}
          </h1>
        </div>
        <span className="text-[12.5px] text-soft">Arbitrum One</span>
      </div>

      <Card>
        <div className="text-[12.5px] text-soft">In your account</div>
        <div className="tabular mt-1 font-medium text-[34px] text-ink tracking-tight">
          {totals ? `${usdc(totals.total)} USDC` : "—"}
        </div>
        <div className="tabular mt-2 font-mono text-[11.5px] text-faint">
          {totals
            ? `${usdc(totals.idle)} liquid · ${usdc(totals.working)} working`
            : factory
              ? "reading the account…"
              : "no account factory deployed yet, so there is nothing to total"}
        </div>
      </Card>
    </>
  );
}
