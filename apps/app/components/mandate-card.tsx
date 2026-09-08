"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import type { Address } from "viem";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useWriteContract,
} from "wagmi";

import { Button } from "@/components/ui/button";
import { CHAIN_ID, totals, useAccountState } from "@/hooks/use-account-state";
import {
  AAVE_V3_POOL,
  accountReadAbi,
  accountWriteAbi,
  hasAgent,
} from "@/lib/account";
import { amount, readMandates, token } from "@/lib/mandates";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

/**
 * What the conversation can answer besides a swap.
 *
 * It used to read `HelicoVault`, and with no vault deployed it answered *"No vault address is set
 * yet — set one on the mandate page"*, pointing at a form that page no longer has. A dead end at
 * the end of a question the front page invites you to ask.
 *
 * Both answers now come from what is actually deployed. **Status** is the account's own state plus
 * the mandates only an indexer can list — which is exactly what "what am I allowed to spend?"
 * means. **Revoke** removes the agent, which is what revoking authority is now: `setAgent(0)` is
 * owner-only, takes effect immediately, and can only ever remove.
 */
export function MandateCard({ action }: { action: "status" | "revoke" }) {
  const { address, isConnected, chainId } = useAccount();
  const client = usePublicClient({ chainId: CHAIN_ID });
  const { data, refetch } = useAccountState();
  const { writeContractAsync } = useWriteContract();

  const account =
    data && data.kind === "open" ? (data.address as Address) : undefined;

  const venue = useReadContract({
    abi: accountReadAbi,
    address: account,
    chainId: CHAIN_ID,
    functionName: "permittedVenue",
    args: [AAVE_V3_POOL],
    query: { enabled: Boolean(account) },
  });

  const mandates = useQuery({
    enabled: Boolean(address),
    queryKey: ["mandates", address],
    queryFn: () => readMandates(address as string),
  });

  const revoke = useMutation({
    mutationFn: async () => {
      if (!account) throw new Error("No account is open");
      const hash = await writeContractAsync({
        abi: accountWriteAbi,
        address: account,
        chainId: CHAIN_ID,
        functionName: "setAgent",
        args: [ZERO],
      });
      await client?.waitForTransactionReceipt({ hash });
      await refetch();
    },
  });

  if (!(isConnected && address)) {
    return <Note>Connect a wallet and this reads your account.</Note>;
  }
  if (chainId !== CHAIN_ID) {
    return <Note>Switch to Arbitrum One to read your account.</Note>;
  }
  if (!data) {
    return (
      <Note>
        <span className="flex items-center gap-2">
          <Loader2 className="size-3 animate-spin" /> Reading your account…
        </span>
      </Note>
    );
  }
  if (data.kind === "unconfigured") {
    return (
      <Note>No account factory is deployed, so there is nothing to read.</Note>
    );
  }
  if (data.kind === "unopened") {
    return (
      <Note>
        Your account is not open yet.{" "}
        <Link className="underline underline-offset-2" href="/">
          Open it
        </Link>
        , and this can answer.
      </Note>
    );
  }

  const held = totals(data);
  const nominated = hasAgent(data);
  const live = mandates.data?.rows.filter((m) => m.active) ?? [];
  const spendable = [...(mandates.data?.spendable ?? new Map())].filter(
    ([, value]) => value > 0n,
  );

  return (
    <div className="mt-3 rounded-xl border p-4">
      <p className="font-medium text-sm">
        {short(data.address)} · {nominated ? "agent nominated" : "no agent"}
      </p>

      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-muted-foreground text-xs">
        <dt>Who may move it</dt>
        <dd>{nominated ? short(data.agent as string) : "nobody but you"}</dd>
        <dt>Where it may go</dt>
        <dd>{venue.data === true ? "Aave v3" : "nowhere yet"}</dd>
        <dt>Holding</dt>
        <dd>
          {held
            ? `${amount(held.idle, 6)} USDC liquid, ${amount(held.working, 6)} working`
            : "nothing yet"}
        </dd>
        <dt>Aqua mandates</dt>
        <dd>
          {mandates.isPending
            ? "reading the index…"
            : mandates.error
              ? "the index did not answer"
              : `${live.length} live`}
        </dd>
      </dl>

      {spendable.length > 0 ? (
        <>
          <p className="mt-3 text-muted-foreground text-xs">
            Still spendable through those mandates:
          </p>
          <ul className="tabular mt-1 font-mono text-[11.5px] text-muted-foreground">
            {spendable.map(([address_, value]) => {
              const t = token(address_ as string);
              return (
                <li key={address_ as string}>
                  {amount(value as bigint, t.decimals)} {t.symbol}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}

      {action === "revoke" ? (
        <div className="mt-4 border-t pt-3">
          {nominated ? (
            <>
              <p className="text-muted-foreground text-xs">
                Removing the agent needs nobody's permission and takes effect at
                once.
              </p>
              {revoke.isSuccess ? (
                <p className="mt-3 text-xs">
                  Removed. Nothing moves without you now.
                </p>
              ) : (
                <Button
                  className="mt-3"
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate()}
                  size="sm"
                  variant="destructive"
                >
                  {revoke.isPending ? "Removing…" : "Remove the agent"}
                </Button>
              )}
              {revoke.error ? (
                <p className="mt-2 text-destructive text-xs">
                  {revoke.error.message.split("\n")[0]}
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-muted-foreground text-xs">
              Nobody is nominated, so there is nothing to revoke.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-3 rounded-xl border p-4 text-muted-foreground text-xs">
      {children}
    </div>
  );
}
