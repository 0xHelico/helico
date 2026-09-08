"use client";

import { useQuery } from "@tanstack/react-query";
import { formatUnits } from "viem";
import { useAccount, usePublicClient } from "wagmi";

import { Glyph } from "@/components/glyph";
import {
  type AccountState,
  configuredFactory,
  hasAgent,
  readAccount,
  workingBps,
} from "@/lib/account";

// Arbitrum One. The idle side is what a swap is paid from; the working side is Aave's receipt
// for the same asset, which is why they are the same token in two states rather than two assets.
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const;
const AUSDC = "0x724dc807b04555b71ed48a6896b6F41593b8C637" as const;

// Arbitrum One, the same chain the rest of the app reads.
const CHAIN_ID = 42161;

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const usdc = (v: bigint) =>
  Number(formatUnits(v, 6)).toLocaleString(undefined, {
    maximumFractionDigits: 2,
  });

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="font-mono text-[12.5px]">{value}</span>
    </div>
  );
}

/**
 * The account, including before it exists.
 *
 * Its address comes from `CREATE2`, so it is knowable before anything is deployed — which is the
 * one thing here worth leading with, and the reason the panel shows an address next to the words
 * "not opened yet" rather than showing nothing.
 *
 * Three states are rendered separately on purpose. A build with no factory address and an owner
 * who has never transacted both amount to "nothing here", and telling them apart is the
 * difference between a missing environment variable and a new user.
 */
export function AccountPanel() {
  const { address, isConnected } = useAccount();
  const client = usePublicClient({ chainId: CHAIN_ID });
  const factory = configuredFactory();

  const { data, error } = useQuery<AccountState>({
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

  const note = (text: string) => (
    <div className="mt-5 rounded-2xl border border-dashed p-4">
      <p className="text-muted-foreground text-xs leading-relaxed">{text}</p>
    </div>
  );

  if (!factory) {
    return note(
      "No account factory is deployed yet, so there is nothing to read. This says so rather than showing a figure, because a screen that invents one is worse than a screen that is empty.",
    );
  }
  if (!isConnected) {
    return note(
      "Connect a wallet and this will show its account address — which exists as an answer before it exists as a contract.",
    );
  }
  if (error) {
    return note(`The chain did not answer: ${error.message.split("\n")[0]}`);
  }
  if (!data || data.kind === "unconfigured") {
    return note("Reading…");
  }

  const bps = workingBps(data);
  const opened = data.kind === "open";

  return (
    <div className="mt-5 rounded-2xl border bg-card p-4">
      <div className="flex items-start gap-4">
        <span className="mt-0.5 shrink-0">
          <Glyph name="bank" size={34} />
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          <Row label="Your account" value={short(data.address)} />
          <Row label="Idle" value={`${usdc(data.idle)} USDC`} />
          <Row label="Working" value={`${usdc(data.working)} USDC`} />
          <Row
            label="At work"
            value={bps === null ? "—" : `${(bps / 100).toFixed(1)}%`}
          />
          <Row
            label="Agent"
            value={
              hasAgent(data)
                ? short((data as { agent: string }).agent)
                : "none nominated"
            }
          />
        </div>
      </div>
      <p className="mt-3.5 text-[10.5px] text-muted-foreground/70 leading-relaxed">
        {opened
          ? "The agent may move capital between markets you allow-listed. Neither call it can make takes a recipient, so it cannot send anything anywhere but here."
          : "Not opened yet — this address is what CREATE2 says it will be, and tokens sent to it now are still yours when it is."}
      </p>
    </div>
  );
}
