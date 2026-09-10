"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useEffect } from "react";
import { type Address, getAddress } from "viem";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useWriteContract,
} from "wagmi";

import { Glyph } from "@/components/glyph";
import { Card, NotDeployed } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { CHAIN_ID, useAccountState } from "@/hooks/use-account-state";
import { useUnlock } from "@/hooks/use-unlock";
import {
  AAVE_V3_POOL,
  accountReadAbi,
  accountWriteAbi,
  configuredFactory,
  factoryAbi,
  HELICO_AGENT,
  hasAgent,
} from "@/lib/account";
import { bestBps, MARKETS, type MarketStatus, readMarkets } from "@/lib/venues";

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
  const { address, isConnected, chainId } = useAccount();
  const client = usePublicClient({ chainId: CHAIN_ID });
  const { data, refetch } = useAccountState();
  const { writeContractAsync } = useWriteContract();
  const factory = configuredFactory();

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

  /**
   * The account is opened by the first thing its owner does with it, not by a button they have to
   * find first.
   *
   * `open` has no access control on chain and returns the existing address rather than reverting
   * when there is one, so this is safe to put in front of every write: it costs one transaction
   * the first time and is skipped every time after. Both setters below revert for a caller that
   * is not the owner, and the account's owner is fixed at construction from the address passed
   * here — so opening on someone's behalf hands them an account and grants nobody anything.
   */
  const openFirst = async () => {
    if (opened || !(factory && client && address)) return;
    const hash = await writeContractAsync({
      abi: factoryAbi,
      address: factory,
      args: [address as Address],
      chainId: CHAIN_ID,
      functionName: "open",
    });
    await client.waitForTransactionReceipt({ hash });
    await refetch();
  };

  // Every market the product offers, with what it pays and whether this account allows it. Read
  // here rather than inside the list so the rates are in hand before anything is rendered — a
  // toggle that appears before its number invites the one choice this screen exists to inform.
  const markets = useQuery({
    enabled: Boolean(client),
    queryFn: () =>
      readMarkets(client as NonNullable<typeof client>, account ?? null),
    queryKey: ["markets", account],
  });

  // One mutation for both writes. They differ by a function name and its arguments, and two
  // near-identical hooks would be two places to forget the receipt wait.
  const write = useMutation({
    mutationFn: async (call: {
      functionName: "setAgent" | "permitVenue";
      args: readonly [Address] | readonly [Address, boolean];
    }) => {
      if (!(account && client)) throw new Error("no account");
      await openFirst();
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

  // Both limits in one confirmation, on wallets that can do it — and now every market rather
  // than Aave alone. The batch itself lives in `useUnlock`, because the onboarding sends the same
  // one and two copies of a six-call batch is two places to forget a market.
  const unlockAll = useUnlock();

  // The batch does not go through `writeContractAsync`, so nothing else refetches for it. Without
  // this the limits below stay reading "none" against an account that has all of them.
  const unlocked = unlockAll.done;
  useEffect(() => {
    if (unlocked) {
      void refetch();
      void venue.refetch();
      void markets.refetch();
    }
  }, [unlocked, refetch, venue.refetch, markets.refetch]);

  const nominated = data ? hasAgent(data) : false;
  const isOurs =
    data?.kind === "open" &&
    data.agent !== null &&
    getAddress(data.agent) === getAddress(HELICO_AGENT);
  const permitted = venue.data === true;
  const permittedCount = (markets.data ?? []).filter((m) => m.permitted).length;
  const best = bestBps(markets.data ?? []);
  const onChain = chainId === CHAIN_ID;
  // Not gated on `opened` any more. The account does not have to exist before someone may say
  // what it permits: the write opens it on the way through, and until they set one of these there
  // is nothing to deploy an account for.
  const canWrite = Boolean(account && factory && isConnected && onChain);

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
        <p className="mb-4 text-[11.5px] text-faint">
          You do not have an account yet. Setting either of these creates it in
          the same step.
        </p>
      )}

      {/* Only for the state a stranger is actually in: open, and configured for nothing. The
          moment either limit is set, the two controls below are the better answer, because
          changing one of them later should not touch the other. */}
      {canWrite && unlockAll.canBatch && !(nominated || permitted) ? (
        <div className="mb-4 rounded-2xl border border-line bg-shade p-4">
          <p className="font-medium text-[13px] text-ink">Turn everything on</p>
          <p className="mt-1 text-[11.5px] text-soft">
            Your wallet can sign these together, so naming the agent and
            allowing all {MARKETS.length} markets takes one signature. None of
            it can move your money.
          </p>
          <Button
            className="mt-3"
            disabled={unlockAll.pending}
            onClick={unlockAll.unlock}
            size="sm"
          >
            {unlockAll.pending
              ? "Setting up…"
              : "Turn everything on with one signature"}
          </Button>
          {unlockAll.error ? (
            <p className="mt-2 text-[11px] text-destructive">
              {unlockAll.error.message.split("\n")[0]}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Limit
          detail={
            nominated
              ? isOurs
                ? "Helico's enclave, and only your idle money."
                : "An address you named."
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
            permittedCount
              ? "Revoke one and the agent can still pull your money back out of it."
              : "Nowhere yet. Pick some below."
          }
          glyph="layers"
          name="Where it may go"
          value={
            permittedCount
              ? `${permittedCount} of ${(markets.data ?? []).length || 4}`
              : "none"
          }
        >
          {/* Only when there is something to name. Empty, this said "The agent can reach nothing
              until you say so." directly under "Nowhere yet. Choose below." — the same sentence
              twice, with a gap between them. */}
          {permittedCount ? (
            <p className="text-[11px] text-faint">
              {(markets.data ?? [])
                .filter((m) => m.permitted)
                .map((m) => `${m.label} ${m.assetSymbol}`)
                .join(", ")}
            </p>
          ) : null}
        </Limit>
      </div>

      {/* **Every market, not the one this file used to name.** Four are deployed and verified;
          until now the only address the product offered was Aave's, so an owner could not say yes
          to a market paying almost twice as much. The addresses are a constant here on purpose —
          permitting is where an owner names something the account trusts afterwards, so the choice
          may not come from anywhere writable. Everything after the choice is derived. */}
      <div className="mt-4 rounded-2xl border border-line bg-shade p-4">
        <div className="flex items-baseline justify-between gap-3">
          <p className="font-medium text-[13px] text-ink">Markets</p>
          <p className="text-[11px] text-faint">
            {best === null
              ? "Rates are read live from each market."
              : `Best on offer right now is ${(best / 100).toFixed(2)}%. The agent moves to whichever pays most.`}
          </p>
        </div>
        <p className="mt-1 text-[11.5px] text-soft">
          The agent can use any market you allow here, and no others. It never
          gets to name where money goes, so the worst it can do is move yours
          between your own places.
        </p>

        <div className="mt-3 flex flex-col gap-2">
          {(
            markets.data ??
            MARKETS.map((m) => ({ ...m, bps: null, permitted: false }))
          ).map((market: MarketStatus) => (
            <MarketRow
              busy={write.isPending}
              canWrite={canWrite}
              key={market.pool}
              market={market}
              onToggle={(next) =>
                write.mutate({
                  functionName: "permitVenue",
                  args: [market.pool, next],
                })
              }
              top={best !== null && market.bps === best}
            />
          ))}
        </div>

        {markets.isLoading ? (
          <p className="mt-3 flex items-center gap-2 text-[11px] text-faint">
            <Loader2 className="size-3 animate-spin" />
            Reading what each market pays.
          </p>
        ) : null}
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

/**
 * One market, what it pays, and the switch that allows it.
 *
 * The rate is shown next to the switch rather than somewhere else on the page, because the whole
 * reason an owner would allow a second market is the number — and a toggle without it asks them to
 * choose between four addresses.
 */
function MarketRow({
  market,
  canWrite,
  busy,
  top,
  onToggle,
}: {
  market: MarketStatus;
  canWrite: boolean;
  busy: boolean;
  top: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line bg-white p-3">
      <div className="min-w-0 flex-1">
        <p className="font-medium text-[12.5px] text-ink leading-none">
          {market.label} <span className="text-soft">{market.assetSymbol}</span>
        </p>
        <p className="mt-1 truncate text-[11px] text-faint">{market.note}</p>
      </div>
      <div className="tabular shrink-0 text-right font-mono text-[12px]">
        {market.bps === null ? (
          <span className="text-faint">no rate</span>
        ) : (
          <span className={top ? "text-ink" : "text-soft"}>
            {(market.bps / 100).toFixed(2)}%
          </span>
        )}
        {top ? (
          <p className="mt-0.5 font-sans text-[10px] text-faint">best</p>
        ) : null}
      </div>
      <Switch
        aria-label={`Permit ${market.label} ${market.assetSymbol}`}
        checked={market.permitted}
        disabled={!canWrite || busy}
        onCheckedChange={onToggle}
      />
    </div>
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
