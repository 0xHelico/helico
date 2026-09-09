"use client";

import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useEffect } from "react";
import { type Address, encodeFunctionData, getAddress } from "viem";
import {
  useAccount,
  useCapabilities,
  usePublicClient,
  useReadContract,
  useSendCalls,
  useWaitForCallsStatus,
  useWriteContract,
} from "wagmi";

import { Glyph } from "@/components/glyph";
import { Card, NotDeployed } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { CHAIN_ID, useAccountState } from "@/hooks/use-account-state";
import {
  AAVE_V3_POOL,
  accountReadAbi,
  accountWriteAbi,
  HELICO_AGENT,
  hasAgent,
} from "@/lib/account";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * The limits, on the contract that actually enforces them.
 *
 * This section used to ask for a `HelicoVault` address and then operate it. That vault is not
 * deployed to Arbitrum One and will not be — CRE moved to the yield layer on 8 September — so the
 * card was a form for a contract that does not exist, on the page making the product's central
 * claim. What is deployed is the account, and the two limits it enforces are owner-only writes on
 * it.
 *
 * They are the whole of the agent's reach, which is why they are the two shown. `supplyIdle` is
 * gated on `permittedVenue`, `withdrawIdle` on `venueEverPermitted`, and neither takes a
 * recipient — so every address the agent can make this account touch is one named here, and the
 * worst a compromised agent does is move the owner's money between the owner's own places.
 */
export function AccountControls() {
  const { isConnected, chainId } = useAccount();
  const client = usePublicClient({ chainId: CHAIN_ID });
  const { data, refetch } = useAccountState();
  const { writeContractAsync } = useWriteContract();

  const account =
    data && data.kind !== "unconfigured"
      ? (data.address as Address)
      : undefined;
  const opened = data?.kind === "open";

  const venue = useReadContract({
    abi: accountReadAbi,
    address: account,
    chainId: CHAIN_ID,
    functionName: "permittedVenue",
    args: [AAVE_V3_POOL],
    query: { enabled: Boolean(account && opened) },
  });

  // One mutation for both writes. They differ by a function name and its arguments, and two
  // near-identical hooks would be two places to forget the receipt wait.
  const write = useMutation({
    mutationFn: async (call: {
      functionName: "setAgent" | "permitVenue";
      args: readonly [Address] | readonly [Address, boolean];
    }) => {
      if (!(account && client)) throw new Error("no account");
      const hash = await writeContractAsync({
        abi: accountWriteAbi,
        address: account,
        chainId: CHAIN_ID,
        ...call,
      } as never);
      await client.waitForTransactionReceipt({ hash });
      await Promise.all([refetch(), venue.refetch()]);
    },
  });

  // Both limits in one confirmation, on wallets that can do it.
  //
  // Not `executeBatch`. That runs each call as the *account*, and both setters are
  // `msg.sender != owner()` reverts, so a batch cannot administer the account it runs on. Proved
  // on a fork rather than reasoned about: `CallFailed(0xBCb6c913…)` naming the account's own
  // address, while the same batch against an external target returns fine (#289).
  //
  // EIP-5792 batches at the wallet instead, so every call keeps the owner as `msg.sender` and
  // both setters pass. A wallet without it falls through to the two controls below, which is
  // exactly today's behaviour, so this can only remove confirmations and never add a failure.
  const capabilities = useCapabilities({ query: { enabled: isConnected } });
  const canBatch =
    capabilities.data?.[CHAIN_ID]?.atomic?.status === "supported" ||
    capabilities.data?.[CHAIN_ID]?.atomic?.status === "ready";

  const send = useSendCalls();
  const batch = useWaitForCallsStatus({ id: send.data?.id });

  // The batch does not go through `writeContractAsync`, so nothing else refetches for it. Without
  // this the two limits below stay reading "none" against an account that has both.
  const batched = batch.data?.status;
  useEffect(() => {
    if (batched === "success") {
      void refetch();
      void venue.refetch();
    }
  }, [batched, refetch, venue.refetch]);

  const setUp = () => {
    if (!account) return;
    send.sendCalls({
      calls: [
        {
          to: account,
          data: encodeFunctionData({
            abi: accountWriteAbi,
            functionName: "setAgent",
            args: [HELICO_AGENT as Address],
          }),
        },
        {
          to: account,
          data: encodeFunctionData({
            abi: accountWriteAbi,
            functionName: "permitVenue",
            args: [AAVE_V3_POOL as Address, true],
          }),
        },
      ],
    });
  };

  const nominated = data ? hasAgent(data) : false;
  const isOurs =
    data?.kind === "open" &&
    data.agent !== null &&
    getAddress(data.agent) === getAddress(HELICO_AGENT);
  const permitted = venue.data === true;
  const onChain = chainId === CHAIN_ID;
  const canWrite = Boolean(account && opened && isConnected && onChain);

  if (!isConnected) {
    return (
      <Card className="mt-4">
        <NotDeployed>
          Connect a wallet to see what its account permits.
        </NotDeployed>
      </Card>
    );
  }

  return (
    <Card className="mt-4">
      {opened ? null : (
        <p className="mt-3 text-[11.5px] text-faint">
          Not open yet. Open it above and these go live.
        </p>
      )}

      {/* Only for the state a stranger is actually in: open, and configured for nothing. The
          moment either limit is set, the two controls below are the better answer, because
          changing one of them later should not touch the other. */}
      {canWrite && canBatch && !(nominated || permitted) ? (
        <div className="mb-4 rounded-2xl border border-line bg-shade p-4">
          <p className="font-medium text-[13px] text-ink">
            Set both limits at once
          </p>
          <p className="mt-1 text-[11.5px] text-soft">
            Your wallet can send them together, so this is one confirmation
            rather than two. Nothing here can move money.
          </p>
          <Button
            className="mt-3"
            disabled={send.isPending || batch.isLoading}
            onClick={setUp}
            size="sm"
          >
            {send.isPending || batch.isLoading
              ? "Setting up…"
              : "Nominate the agent and permit Aave"}
          </Button>
          {send.error ? (
            <p className="mt-2 text-[11px] text-destructive">
              {send.error.message.split("\n")[0]}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Limit
          detail={
            nominated
              ? isOurs
                ? "Helico's enclave. Idle capital only."
                : "An address you nominated."
              : "Nobody. It moves only when you move it."
          }
          glyph="wings"
          name="Who may move it"
          value={
            nominated
              ? isOurs
                ? short(HELICO_AGENT)
                : short((data as { agent: string }).agent)
              : "none"
          }
        >
          {nominated ? (
            <Button
              disabled={!canWrite || write.isPending}
              onClick={() =>
                write.mutate({
                  functionName: "setAgent",
                  args: [
                    "0x0000000000000000000000000000000000000000" as Address,
                  ],
                })
              }
              size="sm"
              variant="outline"
            >
              Remove
            </Button>
          ) : (
            <Button
              disabled={!canWrite || write.isPending}
              onClick={() =>
                write.mutate({
                  functionName: "setAgent",
                  args: [HELICO_AGENT as Address],
                })
              }
              size="sm"
            >
              Nominate Helico's agent
            </Button>
          )}
        </Limit>

        <Limit
          detail={
            permitted
              ? "Aave v3. Revoking leaves the way out open."
              : "Nowhere yet."
          }
          glyph="layers"
          name="Where it may go"
          value={permitted ? "Aave v3" : "none"}
        >
          <Switch
            aria-label="Permit Aave v3 on Arbitrum One"
            checked={permitted}
            disabled={!canWrite || write.isPending}
            onCheckedChange={(next) =>
              write.mutate({
                functionName: "permitVenue",
                args: [AAVE_V3_POOL as Address, next],
              })
            }
          />
        </Limit>
      </div>

      {write.isPending ? (
        <p className="mt-3 flex items-center gap-2 text-[11px] text-faint">
          <Loader2 className="size-3 animate-spin" />
          Waiting for the transaction.
        </p>
      ) : null}
      {write.error ? (
        <p className="mt-3 text-[11px] text-neg">
          {write.error.message.split("\n")[0]}
        </p>
      ) : null}
      {canWrite || !opened ? null : (
        <p className="mt-3 text-[11px] text-faint">
          Switch to Arbitrum One to change either of these.
        </p>
      )}
    </Card>
  );
}

function Limit({
  name,
  value,
  detail,
  glyph,
  children,
}: {
  name: string;
  value: string;
  detail: string;
  glyph: "wings" | "layers";
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col rounded-xl border border-line bg-white p-4">
      <Glyph name={glyph} size={26} />
      <p className="mt-3 font-medium text-[13px] text-ink leading-none">
        {name}
      </p>
      <div className="tabular mt-1.5 font-mono text-[12px] text-ink">
        {value}
      </div>
      <p className="mt-2 flex-1 text-[11px] text-soft leading-relaxed">
        {detail}
      </p>
      <div className="mt-3.5 flex items-center">{children}</div>
    </div>
  );
}
