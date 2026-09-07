"use client";

import { fromContractMandate } from "@helico/plugin-cre/mandate";
import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import {
  useAccount,
  usePublicClient,
  useReadContracts,
  useWriteContract,
} from "wagmi";
import { Button } from "@/components/ui/button";
import { configuredVault, vaultAbi } from "@/lib/vault";

const CHAIN_ID = 42161;

/**
 * What the conversation can reach besides a swap.
 *
 * Both of these already existed on the mandate page and are proven against a real vault; this
 * reads and writes exactly the same functions rather than a second implementation of them. That
 * is the bar for a sentence being answerable at all — the chat reaches what the app already
 * does, and nothing it does not.
 *
 * `status` reads. `revoke` reads first and then offers the button, because ending a mandate that
 * is not there is a transaction that reverts and charges for the news.
 */
export function MandateCard({ action }: { action: "status" | "revoke" }) {
  const { address, isConnected, chainId } = useAccount();
  const vaultAddress = useMemo(() => configuredVault(), []);
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const { writeContractAsync } = useWriteContract();

  const state = useReadContracts({
    contracts: [
      {
        address: vaultAddress ?? undefined,
        abi: vaultAbi,
        chainId: CHAIN_ID,
        functionName: "isActive",
        args: address ? [address] : undefined,
      },
      {
        address: vaultAddress ?? undefined,
        abi: vaultAbi,
        chainId: CHAIN_ID,
        functionName: "positionOf",
        args: address ? [address] : undefined,
      },
      {
        address: vaultAddress ?? undefined,
        abi: vaultAbi,
        chainId: CHAIN_ID,
        functionName: "mandateOf",
        args: address ? [address] : undefined,
      },
    ],
    query: {
      enabled: Boolean(vaultAddress && address && chainId === CHAIN_ID),
    },
  });

  const revoke = useMutation({
    mutationFn: async () => {
      if (!vaultAddress) {
        throw new Error("No vault address");
      }
      const hash = await writeContractAsync({
        address: vaultAddress,
        abi: vaultAbi,
        functionName: "revoke",
      });
      await publicClient?.waitForTransactionReceipt({ hash });
      await state.refetch();
    },
  });

  if (!vaultAddress) {
    return (
      <Card>
        No vault address is set yet.{" "}
        <Link className="underline underline-offset-2" href="/">
          Set one on the mandate page
        </Link>
        , and this can answer.
      </Card>
    );
  }
  if (!(isConnected && address)) {
    return <Card>Connect a wallet and this reads your position.</Card>;
  }
  if (chainId !== CHAIN_ID) {
    return <Card>Switch to Arbitrum One to read your position.</Card>;
  }
  if (state.isPending) {
    return (
      <Card>
        <span className="flex items-center gap-2">
          <Loader2 className="size-3 animate-spin" /> Reading the vault…
        </span>
      </Card>
    );
  }
  if (state.error) {
    return <Card>{state.error.message.split("\n")[0]}</Card>;
  }

  const [active, tokenId, raw] = state.data ?? [];
  if (!(active?.result && raw?.result)) {
    return (
      <Card>
        No mandate is active on this wallet, so the agent may do nothing.{" "}
        <Link className="underline underline-offset-2" href="/">
          Set one
        </Link>
        .
      </Card>
    );
  }

  const mandate = fromContractMandate(raw.result);
  const expires = new Date(mandate.expiry * 1000);

  return (
    <div className="mt-3 rounded-xl border p-4">
      <p className="font-medium text-sm">
        Position #{((tokenId?.result as bigint) ?? 0n).toString()} is under
        mandate.
      </p>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-muted-foreground text-xs">
        <dt>Range width</dt>
        <dd>{mandate.rangeWidthTicks} ticks, exactly</dd>
        <dt>Must improve by</dt>
        <dd>
          {mandate.minImprovementBps / 100}% of the gap, or it may not act
        </dd>
        <dt>Wait between actions</dt>
        <dd>{Math.round(mandate.cooldownSeconds / 60)} minutes</dd>
        <dt>Must keep</dt>
        <dd>{mandate.minRetainedBps / 100}% of the position invested</dd>
        <dt>Ends</dt>
        <dd>{expires.toISOString().slice(0, 16).replace("T", " ")} UTC</dd>
      </dl>

      {action === "revoke" ? (
        <div className="mt-4 border-t pt-3">
          <p className="text-muted-foreground text-xs">
            Revoking needs nobody's permission and works while the contract is
            paused, while the agent is gone, and while an upgrade is pending.
          </p>
          {revoke.isSuccess ? (
            <p className="mt-3 text-xs">
              Revoked. The agent may do nothing on this position now.
            </p>
          ) : (
            <Button
              className="mt-3"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate()}
              size="sm"
              variant="destructive"
            >
              {revoke.isPending ? "Revoking…" : "End the mandate"}
            </Button>
          )}
          {revoke.error ? (
            <p className="mt-2 text-destructive text-xs">
              {revoke.error.message.split("\n")[0]}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-3 rounded-xl border p-4 text-muted-foreground text-xs">
      {children}
    </div>
  );
}
