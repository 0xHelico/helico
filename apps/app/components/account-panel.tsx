"use client";

import { useQuery } from "@tanstack/react-query";
import { formatUnits } from "viem";
import { useAccount, usePublicClient } from "wagmi";

import {
  Card,
  Loading,
  NotDeployed,
  SectionTitle,
  StatTile,
} from "@/components/kit";
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

function _Row({ label, value }: { label: string; value: string }) {
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
    <Card className="mt-4">
      <SectionTitle>Where your capital sits</SectionTitle>
      <div className="mt-3">
        <NotDeployed>{text}</NotDeployed>
      </div>
    </Card>
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
    return (
      <Card className="mt-4">
        <SectionTitle>Where your capital sits</SectionTitle>
        <Loading className="mt-3 h-28" />
      </Card>
    );
  }

  const bps = workingBps(data);
  const opened = data.kind === "open";
  const total = data.idle + data.working;

  return (
    <Card className="mt-4">
      <SectionTitle>Where your capital sits</SectionTitle>

      <div className="tabular mt-3 font-medium text-[32px] text-ink tracking-tight">
        {usdc(total)} <span className="text-[16px] text-soft">USDC</span>
      </div>
      <div className="tabular mt-1 font-mono text-[11.5px] text-faint">
        {short(data.address)} · {opened ? "open" : "not opened yet"}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile name="Liquid" value={`${usdc(data.idle)} USDC`} />
        <StatTile
          name="Working"
          note={bps === null ? undefined : `${(bps / 100).toFixed(1)}% at work`}
          value={`${usdc(data.working)} USDC`}
        />
        <StatTile
          name="Agent"
          value={
            hasAgent(data)
              ? short((data as { agent: string }).agent)
              : "none nominated"
          }
        />
      </div>

      <p className="mt-4 text-[11px] text-faint leading-relaxed">
        {opened
          ? "The agent may move capital between markets you allow-listed. Neither call it can make takes a recipient, so it cannot send anything anywhere but here."
          : "This address is what CREATE2 says it will be. Tokens sent to it now are still yours when it exists."}
      </p>
    </Card>
  );
}
