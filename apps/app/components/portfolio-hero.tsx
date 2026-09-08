"use client";

import { useQuery } from "@tanstack/react-query";
import { formatUnits } from "viem";
import { useAccount, usePublicClient } from "wagmi";

import { GeneratedAvatar } from "@/components/generated-avatar";
import { Card } from "@/components/kit";
import { byDay, Sparkline } from "@/components/sparkline";
import {
  type AccountState,
  configuredFactory,
  readAccount,
} from "@/lib/account";
import { readMovements } from "@/lib/mandates";

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

  // The chart is Aqua movement, which is real; a value-over-time line would need a price feed and
  // a history nobody is keeping, and inventing one is the thing this page refuses everywhere else.
  const moves = useQuery({
    enabled: Boolean(address),
    queryKey: ["movements", address],
    queryFn: () => readMovements(address as string),
  });
  const days = moves.data ? byDay(moves.data.timestamps) : [];

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
          {/* Seeded on the address, so a wallet looks the same on every visit and two
              wallets never look alike. */}
          <GeneratedAvatar name={address ?? "helico"} size={36} />
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
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
          <div className="sm:w-[42%]">
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
          </div>
          <div className="min-w-0 flex-1">
            {days.length > 0 ? (
              <Sparkline days={days} label="Aqua movements per day" />
            ) : null}
          </div>
        </div>
      </Card>
    </>
  );
}
