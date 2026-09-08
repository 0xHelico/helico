"use client";

import { positionManagerAbi } from "@helico/plugin-cre/abi";
import {
  fromContractMandate,
  type Mandate,
  mandateRefusedBecause,
  toContractMandate,
} from "@helico/plugin-cre/mandate";
import { addresses, poolId } from "@helico/plugin-uniswap";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { erc721Abi, zeroAddress } from "viem";
import {
  useAccount,
  usePublicClient,
  useReadContracts,
  useWriteContract,
} from "wagmi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { VaultSetup } from "@/components/vault-setup";
import { configuredVault, MANDATE_DEFAULTS, vaultAbi } from "@/lib/vault";

const CHAIN_ID = 42161;
const DAY = 24 * 60 * 60;

/** Rounds down to a whole number of the pool's tick spacings, which is what the vault demands. */
const snap = (ticks: number, spacing: number) =>
  spacing > 0
    ? Math.max(spacing, Math.floor(ticks / spacing) * spacing)
    : ticks;

export function MandatePanel() {
  const { address, isConnected, chainId } = useAccount();
  // Bumped when an address is saved, so the panel re-reads it without a reload.
  const [nonce, setNonce] = useState(0);
  const publicClient = usePublicClient({ chainId: CHAIN_ID });

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read whenever an address is saved
  const vaultAddress = useMemo(() => configuredVault(), [nonce]);

  if (!vaultAddress) {
    return <VaultSetup current={null} onSaved={() => setNonce((n) => n + 1)} />;
  }
  if (!(isConnected && address)) {
    return <Note>Connect a wallet to see the rules on your position.</Note>;
  }
  if (chainId !== CHAIN_ID) {
    return <Note>Switch to Arbitrum One to see your position.</Note>;
  }
  if (!publicClient) {
    return <Note>No connection to Arbitrum One.</Note>;
  }

  return <Connected address={address} vaultAddress={vaultAddress} />;
}

function Connected({
  address,
  vaultAddress,
}: {
  address: `0x${string}`;
  vaultAddress: `0x${string}`;
}) {
  const vault = vaultAddress;
  const contract = {
    address: vault,
    abi: vaultAbi,
    chainId: CHAIN_ID,
  } as const;

  const state = useReadContracts({
    contracts: [
      { ...contract, functionName: "isActive", args: [address] },
      { ...contract, functionName: "positionOf", args: [address] },
      { ...contract, functionName: "mandateOf", args: [address] },
    ],
  });

  if (state.isPending) {
    return <Note icon>Reading your position…</Note>;
  }
  if (state.error) {
    return <Note>{state.error.message.split("\n")[0]}</Note>;
  }

  const [active, tokenId, raw] = state.data ?? [];
  if (active?.result && raw?.result) {
    return (
      <Active
        mandate={fromContractMandate(raw.result)}
        onDone={() => state.refetch()}
        tokenId={(tokenId?.result as bigint) ?? 0n}
        vaultAddress={vaultAddress}
      />
    );
  }
  return (
    <Compose
      address={address}
      onDone={() => state.refetch()}
      vaultAddress={vaultAddress}
    />
  );
}

function Active({
  mandate,
  tokenId,
  onDone,
  vaultAddress,
}: {
  mandate: Mandate;
  tokenId: bigint;
  onDone: () => void;
  vaultAddress: `0x${string}`;
}) {
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: CHAIN_ID });

  const revoke = useMutation({
    mutationFn: async () => {
      const hash = await writeContractAsync({
        address: vaultAddress,
        abi: vaultAbi,
        functionName: "revoke",
      });
      await publicClient?.waitForTransactionReceipt({ hash });
      onDone();
    },
  });

  const expires = new Date(mandate.expiry * 1000);

  return (
    <div className="mt-8 rounded-xl border p-5">
      <p className="font-medium">
        Position #{tokenId.toString()} is under mandate.
      </p>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Range width</dt>
        <dd>{mandate.rangeWidthTicks} ticks, exactly</dd>
        <dt className="text-muted-foreground">Must improve by</dt>
        <dd>
          {mandate.minImprovementBps / 100}% of the gap, or the agent may not
          act
        </dd>
        <dt className="text-muted-foreground">Wait between actions</dt>
        <dd>{Math.round(mandate.cooldownSeconds / 60)} minutes</dd>
        <dt className="text-muted-foreground">Most it may move</dt>
        <dd>{mandate.maxLiquidity.toString()} of liquidity</dd>
        <dt className="text-muted-foreground">Must keep</dt>
        <dd>{mandate.minRetainedBps / 100}% of the position invested</dd>
        <dt className="text-muted-foreground">Ends</dt>
        <dd>{expires.toISOString().slice(0, 16).replace("T", " ")} UTC</dd>
      </dl>

      <div className="mt-5 border-t pt-4">
        <p className="text-muted-foreground text-sm">
          Revoking needs nobody's permission and works while the contract is
          paused, while the agent is gone, and while an upgrade is pending.
        </p>
        <Button
          className="mt-3"
          disabled={revoke.isPending}
          onClick={() => revoke.mutate()}
          size="sm"
          variant="destructive"
        >
          {revoke.isPending ? "Revoking…" : "End the mandate"}
        </Button>
        {revoke.error ? (
          <p className="mt-2 text-destructive text-xs">
            {revoke.error.message.split("\n")[0]}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Compose({
  address,
  onDone,
  vaultAddress,
}: {
  address: `0x${string}`;
  onDone: () => void;
  vaultAddress: `0x${string}`;
}) {
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const { writeContractAsync } = useWriteContract();
  const [tokenIdText, setTokenIdText] = useState("");
  const [terms, setTerms] = useState<
    Record<keyof typeof MANDATE_DEFAULTS, number>
  >({
    ...MANDATE_DEFAULTS,
  });

  const tokenId = /^\d+$/.test(tokenIdText.trim())
    ? BigInt(tokenIdText.trim())
    : undefined;

  // Everything the terms have to agree with comes from the position itself, so it is read
  // rather than typed: the pool it is in, that pool's spacing, and how much liquidity it holds.
  const position = useQuery({
    queryKey: ["position", tokenId?.toString(), address],
    enabled: Boolean(publicClient && tokenId !== undefined),
    retry: false,
    queryFn: async () => {
      if (!(publicClient && tokenId !== undefined)) {
        throw new Error("No client");
      }
      const positionManager = addresses(CHAIN_ID).positionManager;
      const [owner, [key], liquidity, approved] = await Promise.all([
        publicClient.readContract({
          address: positionManager,
          abi: erc721Abi,
          functionName: "ownerOf",
          args: [tokenId],
        }),
        publicClient.readContract({
          address: positionManager,
          abi: positionManagerAbi,
          functionName: "getPoolAndPositionInfo",
          args: [tokenId],
        }),
        publicClient.readContract({
          address: positionManager,
          abi: positionManagerAbi,
          functionName: "getPositionLiquidity",
          args: [tokenId],
        }),
        publicClient.readContract({
          address: positionManager,
          abi: erc721Abi,
          functionName: "getApproved",
          args: [tokenId],
        }),
      ]);
      return {
        positionManager,
        owner,
        key,
        liquidity,
        approved,
        poolId: poolId(key),
      };
    },
  });

  const p = position.data;
  const yours = p ? p.owner.toLowerCase() === address.toLowerCase() : false;
  const spacing = p?.key.tickSpacing ?? 0;
  const width = p
    ? snap(terms.rangeWidthTicks, spacing)
    : terms.rangeWidthTicks;

  const mandate: Mandate | undefined = p
    ? {
        poolId: p.poolId,
        rangeWidthTicks: width,
        minImprovementBps: terms.minImprovementBps,
        cooldownSeconds: terms.cooldownSeconds,
        maxLiquidity: p.liquidity,
        expiry: Math.floor(Date.now() / 1000) + terms.expiryDays * DAY,
        minRetainedBps: terms.minRetainedBps,
      }
    : undefined;

  const refused = mandate
    ? mandateRefusedBecause(mandate, { tickSpacing: spacing })
    : undefined;
  const needsApproval = p
    ? p.approved.toLowerCase() !== vaultAddress.toLowerCase()
    : false;

  const commit = useMutation({
    mutationFn: async () => {
      if (!(p && mandate && tokenId !== undefined && publicClient)) {
        throw new Error("Nothing to commit");
      }
      if (needsApproval) {
        const hash = await writeContractAsync({
          address: p.positionManager,
          abi: erc721Abi,
          functionName: "approve",
          args: [vaultAddress, tokenId],
        });
        await publicClient.waitForTransactionReceipt({ hash });
      }
      const hash = await writeContractAsync({
        address: vaultAddress,
        abi: vaultAbi,
        functionName: "setMandate",
        args: [tokenId, toContractMandate(mandate)],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      onDone();
    },
  });

  return (
    <div className="mt-8 rounded-xl border p-5">
      <p className="text-muted-foreground text-sm">
        You keep the position. Helico never holds it — it may only move it
        inside these limits, and only while you allow it.
      </p>

      {/* Two columns for the numbers. Six full-width rows for six short integers was most of
          why this panel read as long. */}
      <div className="mt-5 space-y-4 [&_.pair]:grid [&_.pair]:gap-4 sm:[&_.pair]:grid-cols-2">
        <Field hint="Uniswap v4, on Arbitrum One." label="Position">
          <Input
            inputMode="numeric"
            onChange={(e) => setTokenIdText(e.target.value)}
            placeholder="e.g. 12345"
            value={tokenIdText}
          />
        </Field>

        {position.isPending && tokenId !== undefined ? (
          <Note icon>Reading position #{tokenId.toString()}…</Note>
        ) : null}
        {position.error ? (
          <Note>
            No position numbered {tokenIdText} on Arbitrum One, or it has been
            burned.
          </Note>
        ) : null}
        {p && !yours ? (
          <Note>
            Position #{tokenIdText} belongs to {p.owner.slice(0, 10)}…, not to
            you. The vault refuses rules written by anyone but the owner.
          </Note>
        ) : null}

        {p && yours ? (
          <>
            <div className="pair">
              <Field
                hint={`A whole number of this pool's ${spacing}-tick spacings. ${
                  width === terms.rangeWidthTicks
                    ? ""
                    : `Rounded to ${width} to fit.`
                }`}
                label="Range width"
              >
                <Input
                  inputMode="numeric"
                  onChange={(e) =>
                    setTerms({
                      ...terms,
                      rangeWidthTicks: Number(e.target.value) || 0,
                    })
                  }
                  value={terms.rangeWidthTicks}
                />
              </Field>
              <Field
                hint="Basis points. Below it the agent may not act, so it cannot churn for nothing."
                label="Worth the move"
              >
                <Input
                  inputMode="numeric"
                  onChange={(e) =>
                    setTerms({
                      ...terms,
                      minImprovementBps: Number(e.target.value) || 0,
                    })
                  }
                  value={terms.minImprovementBps}
                />
              </Field>
              <Field
                hint="Seconds between actions, at the shortest."
                label="Cooldown"
              >
                <Input
                  inputMode="numeric"
                  onChange={(e) =>
                    setTerms({
                      ...terms,
                      cooldownSeconds: Number(e.target.value) || 0,
                    })
                  }
                  value={terms.cooldownSeconds}
                />
              </Field>
              <Field
                hint="Basis points. Re-centring withdraws it all; this is the least that goes back."
                label="Keep invested"
              >
                <Input
                  inputMode="numeric"
                  onChange={(e) =>
                    setTerms({
                      ...terms,
                      minRetainedBps: Number(e.target.value) || 0,
                    })
                  }
                  value={terms.minRetainedBps}
                />
              </Field>
            </div>
            <Field
              hint="Days. The authority lapses on its own."
              label="Expires in"
            >
              <Input
                inputMode="numeric"
                onChange={(e) =>
                  setTerms({
                    ...terms,
                    expiryDays: Number(e.target.value) || 0,
                  })
                }
                value={terms.expiryDays}
              />
            </Field>

            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 border-t pt-4 text-muted-foreground text-xs">
              <dt>Pool</dt>
              <dd className="break-all">{p.poolId}</dd>
              <dt>Most it may move</dt>
              <dd>
                {p.liquidity.toString()} — the position's whole liquidity, read
                from the chain rather than declared
              </dd>
              <dt>Hook</dt>
              <dd>{p.key.hooks === zeroAddress ? "none" : p.key.hooks}</dd>
            </dl>

            {refused ? (
              <p className="text-destructive text-xs">
                The vault would refuse these terms: {refused}.
              </p>
            ) : null}

            <Button
              disabled={Boolean(refused) || commit.isPending}
              onClick={() => commit.mutate()}
            >
              {commit.isPending
                ? "Signing…"
                : needsApproval
                  ? "Approve the position, then commit the rules"
                  : "Commit the rules"}
            </Button>
            {commit.error ? (
              <p className="text-destructive text-xs">
                {commit.error.message.split("\n")[0]}
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="font-normal text-sm">{label}</Label>
      {children}
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  );
}

function Note({
  children,
  icon,
}: {
  children: React.ReactNode;
  icon?: boolean;
}) {
  return (
    <p className="mt-8 flex items-center gap-2 rounded-xl border p-4 text-muted-foreground text-sm">
      {icon ? <Loader2 className="size-3 shrink-0 animate-spin" /> : null}
      {children}
    </p>
  );
}
