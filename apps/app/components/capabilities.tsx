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

  const isActive = useReadContract({
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
      await isActive.refetch();
    },
  });

  const active = Boolean(isActive.data);
  const canToggle = Boolean(vault && isConnected && chainId === CHAIN_ID);

  return (
    <ul className="mt-4 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
      {GRANTS.map((g) => {
        // Keyed off the flag, not the position. This read `i === 0` until the list was
        // reordered, at which point the switch would have followed the order rather than the
        // contract — and nothing would have said so.
        const live = g.wired;
        return (
          <li
            className={cn(
              "glyph-hover flex flex-col rounded-2xl border p-4 transition-colors",
              live
                ? "border-line bg-white hover:border-[var(--helico-on)]/40"
                : "border-dashed bg-transparent",
            )}
            key={g.name}
          >
            <div className="flex items-start justify-between gap-3">
              <Glyph name={g.glyph} size={28} />
              {live && revoke.isPending ? (
                <Loader2 className="mt-1 size-4 animate-spin text-faint" />
              ) : live ? (
                <Switch
                  aria-label={g.name}
                  checked={active}
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
            </div>
            <p className="mt-3 font-medium text-[13px] text-ink leading-none">
              {g.name}
            </p>
            <p className="mt-2 flex-1 text-[11.5px] text-soft leading-relaxed">
              {g.detail}
            </p>
            <p className="mt-3 text-[10.5px] text-faint">
              {live ? (active ? "granted" : "not granted") : "not wired yet"}
            </p>
            {live && revoke.error ? (
              <p className="mt-1 text-[10.5px] text-neg">
                {revoke.error.message.split("\n")[0]}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

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
