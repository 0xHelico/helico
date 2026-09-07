"use client";

import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useWriteContract,
} from "wagmi";
import { Glyph } from "@/components/glyph";
import { Switch } from "@/components/ui/switch";
import { ASKS, GRANTS } from "@/lib/capabilities";
import { cn } from "@/lib/utils";
import { configuredVault, vaultAbi } from "@/lib/vault";

const CHAIN_ID = 42161;

/**
 * What the agent may be allowed to do.
 *
 * The first switch is real: it reads whether a mandate is active on chain, and turning it off
 * revokes — which is both a true action and the safest write we have, since it can only remove
 * authority. Turning it on sends you to the form below, because granting authority should be a
 * decision made in front of its limits rather than a toggle.
 *
 * Every other switch is genuinely `disabled`. Showing where the product is going is worth
 * something; implying it has arrived would be worth losing the submission over, so the difference
 * is in the markup and not in a sentence somebody has to read.
 */
export function Grants() {
  const { address, isConnected, chainId } = useAccount();
  const vault = useMemo(() => configuredVault(), []);
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const { writeContractAsync } = useWriteContract();

  const active = useReadContract({
    abi: vaultAbi,
    address: vault ?? undefined,
    chainId: CHAIN_ID,
    functionName: "isActive",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(vault && address && chainId === CHAIN_ID) },
  });

  const revoke = useMutation({
    mutationFn: async () => {
      if (!vault) {
        throw new Error("No vault address");
      }
      const hash = await writeContractAsync({
        abi: vaultAbi,
        address: vault,
        functionName: "revoke",
      });
      await publicClient?.waitForTransactionReceipt({ hash });
      await active.refetch();
    },
  });

  const live = Boolean(active.data);
  const canToggle = Boolean(vault && isConnected && chainId === CHAIN_ID);

  return (
    <ul className="mt-5 grid gap-2.5">
      {GRANTS.map((g, i) => {
        const first = i === 0;
        return (
          <li
            className={cn(
              "glyph-hover flex items-start gap-4 rounded-2xl border p-4 transition-colors",
              g.wired
                ? "bg-card hover:border-[var(--helico-on)]/40"
                : "border-dashed opacity-55",
            )}
            key={g.name}
          >
            <span className="mt-0.5 shrink-0">
              <Glyph name={g.glyph} size={34} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-medium text-[13.5px] leading-none">{g.name}</p>
              <p className="mt-2 text-muted-foreground text-xs leading-relaxed">
                {g.detail}
              </p>
              {first && revoke.error ? (
                <p className="mt-2 text-destructive text-xs">
                  {revoke.error.message.split("\n")[0]}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1.5">
              {first && revoke.isPending ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              ) : first ? (
                <Switch
                  aria-label={g.name}
                  checked={live}
                  disabled={!canToggle}
                  onCheckedChange={(next) => {
                    if (next) {
                      document
                        .getElementById("mandate")
                        ?.scrollIntoView({ behavior: "smooth" });
                    } else {
                      revoke.mutate();
                    }
                  }}
                />
              ) : (
                <Switch aria-label={g.name} checked={false} disabled />
              )}
              <span className="text-[10.5px] text-muted-foreground/60">
                {first ? (live ? "granted" : "not granted") : "not wired yet"}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Sentences the conversation answers today. Each happens once, and you sign it. */
export function Asks() {
  return (
    <ul className="mt-5 grid gap-2.5 sm:grid-cols-3">
      {ASKS.map((a) => (
        <li key={a.name}>
          <Link
            className="glyph-hover flex h-full flex-col rounded-2xl border bg-card p-4 transition-colors hover:border-[var(--helico-on)]/40"
            href="/chat"
          >
            <Glyph name={a.glyph} size={32} />
            <p className="mt-3 font-medium text-[13.5px] leading-none">
              {a.name}
            </p>
            <p className="mt-2 text-muted-foreground text-xs leading-relaxed">
              {a.detail}
            </p>
            <p className="mt-3 text-[11px] text-muted-foreground/60 italic">
              “{a.say}”
            </p>
          </Link>
        </li>
      ))}
    </ul>
  );
}
