"use client";

import { useMutation } from "@tanstack/react-query";
import { type Address, formatUnits } from "viem";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";

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
import { Button } from "@/components/ui/button";
import { CHAIN_ID, useAccountState } from "@/hooks/use-account-state";
import {
  configuredFactory,
  factoryAbi,
  hasAgent,
  workingBps,
} from "@/lib/account";

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
  const { address, isConnected, chainId } = useAccount();
  const client = usePublicClient({ chainId: CHAIN_ID });
  const factory = configuredFactory();
  const { writeContractAsync } = useWriteContract();

  // One read for the page. The hero and the summary ask for the same key, so react-query
  // answers all three from a single set of calls rather than three of everything.
  const { data, error, refetch } = useAccountState();

  const openAccount = useMutation({
    mutationFn: async () => {
      if (!(factory && client && address)) throw new Error("nothing to open");
      const hash = await writeContractAsync({
        abi: factoryAbi,
        address: factory,
        args: [address as Address],
        chainId: CHAIN_ID,
        functionName: "open",
      });
      await client.waitForTransactionReceipt({ hash });
      await refetch();
    },
  });

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
      "No account factory is deployed yet, so there is nothing to read. Saying so beats showing a figure that is not there.",
    );
  }
  if (!isConnected) {
    return note(
      "Connect a wallet to see its account address — an answer before it is a contract.",
    );
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
          mark={<TokenMark symbol="USDC" />}
          note="liquid"
          symbol="USDC"
          tint="bg-[#eef3fb]"
          value={usdc(data.idle)}
        />
        <AssetTile
          mark={<TokenMark symbol="aUSDC" />}
          note={
            bps === null ? "working" : `working · ${(bps / 100).toFixed(1)}%`
          }
          symbol="aUSDC"
          tint="bg-[#ecf5f0]"
          value={usdc(data.working)}
        />
        <StatTile
          icon={<Glyph name="wings" size={24} />}
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
            ? "The agent may move capital between markets you allow-listed. Neither call it can make takes a recipient, so it cannot send anything anywhere but here."
            : "Nobody is nominated, so nothing here moves without you. The workflow running in the enclave watches the one account named in its configuration — opening this one does not add it."
          : "This address is what CREATE2 says it will be. Tokens sent to it now are still yours when it exists."}
      </p>

      {opened ? null : (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            disabled={openAccount.isPending || chainId !== CHAIN_ID}
            onClick={() => openAccount.mutate()}
            size="sm"
          >
            {openAccount.isPending ? "Opening…" : "Open this account"}
          </Button>
          <span className="text-[11px] text-faint">
            {chainId === CHAIN_ID
              ? "One transaction, from your wallet. It grants nothing and takes nothing."
              : "Switch to Arbitrum One to open it."}
          </span>
        </div>
      )}
      {openAccount.error ? (
        <p className="mt-2 text-[11px] text-neg">
          {openAccount.error.message.split("\n")[0]}
        </p>
      ) : null}
    </Card>
  );
}
