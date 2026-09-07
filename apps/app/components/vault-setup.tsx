"use client";

import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { type Address, isAddress } from "viem";
import { usePublicClient } from "wagmi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { checkVault, rememberVault } from "@/lib/vault";

const CHAIN_ID = 42161;

/**
 * Where the vault's address comes from when the build did not carry one.
 *
 * It is checked, not taken. The address must have code, and must answer with the same position
 * manager, state view and pool manager that this chain's Uniswap v4 deployment uses — which is
 * what separates a Helico vault from a typo, an EOA, or a vault someone deployed against a
 * different periphery. Nothing is stored until it passes.
 */
export function VaultSetup({
  current,
  onSaved,
}: {
  current: Address | null;
  onSaved: () => void;
}) {
  const client = usePublicClient({ chainId: CHAIN_ID });
  const [value, setValue] = useState(current ?? "");

  const check = useMutation({
    mutationFn: async () => {
      const address = value.trim();
      if (!isAddress(address)) {
        throw new Error("That is not a 20-byte address.");
      }
      if (!client) {
        throw new Error("No connection to Arbitrum One.");
      }
      const result = await checkVault(client, address as Address, CHAIN_ID);
      if (!result.ok) {
        throw new Error(result.reason);
      }
      rememberVault(address as Address);
      onSaved();
      return result;
    },
  });

  return (
    <div className="mt-8 rounded-xl border p-5">
      <p className="font-medium">Point this at the vault</p>
      <p className="mt-2 text-muted-foreground text-sm leading-relaxed">
        Helico's vault is not deployed to Arbitrum One yet. When it is, put its
        address here — no rebuild, and it is remembered in this browser.
      </p>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <Input
          onChange={(e) => setValue(e.target.value)}
          placeholder="0x…"
          spellCheck={false}
          value={value}
        />
        <Button
          disabled={check.isPending || value.trim() === ""}
          onClick={() => check.mutate()}
        >
          {check.isPending ? (
            <>
              <Loader2 className="size-3.5 animate-spin" /> Checking
            </>
          ) : (
            "Check and use"
          )}
        </Button>
      </div>

      {check.error ? (
        <p className="mt-3 text-destructive text-sm">{check.error.message}</p>
      ) : null}

      <p className="mt-4 border-t pt-3 text-muted-foreground text-xs leading-relaxed">
        It is read before it is trusted: the address must have code, and must
        name the same position manager, state view and pool manager as Arbitrum
        One's own Uniswap v4 deployment. An address from another chain or
        another deployment is refused rather than half-working.
      </p>
    </div>
  );
}
