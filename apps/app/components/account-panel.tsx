"use client";

import { formatUnits } from "viem";
import { useAccount } from "wagmi";

import { Glyph } from "@/components/glyph";
import {
  AssetTile,
  Card,
  Loading,
  NotDeployed,
  SectionTitle,
  StatTile,
} from "@/components/kit";
import { TokenMark } from "@/components/token-mark";
import { useAccountState } from "@/hooks/use-account-state";
import { configuredFactory, hasAgent, workingBps } from "@/lib/account";

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
 * It reports and does not act. Opening used to be a button here, and it is now the first limit
 * the owner sets on the front page: `open` has no access control and returns the existing address
 * rather than reverting, so the write that needs an account can just make one, and a separate
 * transaction to deploy an empty contract is a step nobody gained anything by taking.
 *
 * Three states are rendered separately on purpose. A build with no factory address and an owner
 * who has never transacted both amount to "nothing here", and telling them apart is the
 * difference between a missing environment variable and a new user.
 */
export function AccountPanel() {
  const { isConnected } = useAccount();
  const factory = configuredFactory();

  // One read for the page. The hero and the summary ask for the same key, so react-query
  // answers all three from a single set of calls rather than three of everything.
  const { data, error } = useAccountState();

  const note = (text: string) => (
    <Card className="mt-4">
      <SectionTitle>Your account</SectionTitle>
      <div className="mt-3">
        <NotDeployed>{text}</NotDeployed>
      </div>
    </Card>
  );

  if (!factory) {
    return note(
      "No account factory is deployed yet, so there is nothing to read.",
    );
  }
  if (!isConnected) {
    return note("Connect a wallet to see its account address.");
  }
  if (error) {
    return note(`The chain did not answer: ${error.message.split("\n")[0]}`);
  }
  if (!data || data.kind === "unconfigured") {
    return (
      <Card className="mt-4">
        <SectionTitle>Your account</SectionTitle>
        <Loading className="mt-3 h-28" />
      </Card>
    );
  }

  const bps = workingBps(data);
  const opened = data.kind === "open";

  return (
    <Card className="mt-4">
      <SectionTitle>Your account</SectionTitle>

      <div className="tabular mt-1 font-mono text-[11.5px] text-faint">
        {short(data.address)} · {opened ? "open" : "not opened yet"}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <AssetTile
          mark={<TokenMark size={22} symbol="USDC" />}
          note="liquid"
          symbol="USDC"
          tint="bg-[#eef3fb]"
          value={usdc(data.idle)}
        />
        <AssetTile
          mark={<TokenMark size={22} symbol="aUSDC" />}
          note={
            bps === null ? "working" : `working · ${(bps / 100).toFixed(1)}%`
          }
          symbol="aUSDC"
          tint="bg-[#ecf5f0]"
          value={usdc(data.working)}
        />
        <StatTile
          icon={<Glyph name="wings" size={22} />}
          name="Agent"
          note={hasAgent(data) ? "nominated" : "nobody may move it"}
          value={
            hasAgent(data) ? short((data as { agent: string }).agent) : "none"
          }
        />
      </div>

      <p className="mt-4 text-[11px] text-faint leading-relaxed">
        {opened
          ? hasAgent(data)
            ? "Both calls the agent can make end here. It has no way to send anything anywhere else."
            : "Nobody is nominated, so nothing here moves without you."
          : "This address is what CREATE2 says it will be. Tokens sent now are yours when it exists, and setting a limit on the front page builds it."}
      </p>
    </Card>
  );
}
