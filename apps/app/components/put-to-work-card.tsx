"use client";

import {
  ARBITRUM_ONE,
  MANDATE_SWAP_ABI,
  mandateHash,
  mandateSetupCalls,
  mandateSwapAddress,
  ReceiptKind,
  type SwapMandate,
} from "@helico/plugin-1inch";
import { useQuery } from "@tanstack/react-query";
import { Check, Loader2 } from "lucide-react";
import { useState } from "react";
import {
  type Address,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  parseAbi,
  zeroAddress,
} from "viem";
import {
  useAccount,
  useCapabilities,
  usePublicClient,
  useSendCalls,
  useWaitForCallsStatus,
} from "wagmi";

import { FundAccount } from "@/components/fund-account";
import { Button } from "@/components/ui/button";
import { CHAIN_ID, useAccountState } from "@/hooks/use-account-state";
import {
  ACCOUNT_TOKENS,
  accountWriteAbi,
  configuredFactory,
  factoryAbi,
  HELICO_AGENT,
  hasAgent,
} from "@/lib/account";
import { explorerTx } from "@/lib/chain";
import { cn } from "@/lib/utils";
import { MARKETS, readVenues } from "@/lib/venues";

const USDC: Address = ACCOUNT_TOKENS.idle;
const WETH: Address = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";

const accountBatchAbi = parseAbi([
  "struct Call { address target; uint256 value; bytes data; }",
  "function executeBatch(Call[] calls) returns (bytes[])",
]);

/** A day. Long enough for a demo, short enough that a forgotten mandate dies on its own. */
const LIFETIME_SECONDS = 86_400n;
const FEE_BPS = 30n;

const usdc = (v: bigint) =>
  Number(formatUnits(v, 6)).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/**
 * Everything, in one press.
 *
 * **This is a composition, not a new mechanism.** Arming the account, funding it and shipping a
 * maker position are each built and each proven; what has never existed is one caller for all of
 * them. `docs/plans/2026-09-12-one-button-puts-it-all-to-work.md` has the table of which call
 * needs which `msg.sender` and why that matters.
 *
 * **EIP-5792 is what makes one press possible.** `sendCalls` batches at the wallet, so every call
 * keeps the owner as `msg.sender`: `setAgent` and `permitVenue` pass, the transfer passes, and the
 * ship goes through `executeBatch`, which is owner-gated and runs its inner calls *as the account*.
 * One `executeBatch` for the lot would not work — that runs everything as the account, and the
 * account cannot administer itself: `setAgent` reverts on `msg.sender != owner()`, measured on a
 * fork in #289.
 *
 * A wallet without EIP-5792 is told so and pointed at the controls that do the same job one
 * transaction at a time. That is not a failure and is not dressed as one.
 *
 * **The last line of the breakdown is not in the batch, and says so.** This press ships and funds;
 * the supplying is the enclave's, on its next run, into whichever market pays most. The reason it
 * belongs on the list anyway is that the same capital does both jobs — `AquaYieldCover` redeems
 * exactly the shortfall out of the lending position when a taker fills, so shipping and earning are
 * two claims on the whole of the money rather than a split of it.
 */
export function PutToWorkCard({
  /** Without its own border, for when it sits inside another card. */
  plain = false,
}: {
  plain?: boolean;
} = {}) {
  const { address, isConnected } = useAccount();
  const client = usePublicClient({ chainId: CHAIN_ID });
  const { data } = useAccountState();
  const factory = configuredFactory();

  const capabilities = useCapabilities({ query: { enabled: isConnected } });
  const atomic = capabilities.data?.[CHAIN_ID]?.atomic?.status;
  const canBatch = atomic === "supported" || atomic === "ready";

  const send = useSendCalls();
  const batch = useWaitForCallsStatus({ id: send.data?.id });
  // **A refusal before the batch is still a refusal to show.** The checks in `run` can stop the
  // press — an encoding the contract does not agree with, an account with nothing in it — and
  // swallowing those left a button that did nothing and said nothing.
  const [refused, setRefused] = useState<string | null>(null);

  const account =
    data && data.kind !== "unconfigured"
      ? (data.address as Address)
      : undefined;
  const opened = data?.kind === "open";
  const armed = opened && hasAgent(data);

  // Fresh on mount rather than the app's one-minute default: these decide what is sent, and a
  // minute-old balance is money the batch would refuse to move.
  const balances = useQuery({
    enabled: Boolean(account && address && client),
    queryKey: ["put-to-work", account, address],
    staleTime: 0,
    queryFn: async () => {
      const c = client as NonNullable<typeof client>;
      const [wallet, idle, weth] = await Promise.all([
        c.readContract({
          abi: erc20Abi,
          address: USDC,
          args: [address as Address],
          functionName: "balanceOf",
        }),
        c.readContract({
          abi: erc20Abi,
          address: USDC,
          args: [account as Address],
          functionName: "balanceOf",
        }),
        c.readContract({
          abi: erc20Abi,
          address: WETH,
          args: [account as Address],
          functionName: "balanceOf",
        }),
      ]);
      return { wallet, idle, weth };
    },
  });

  const venues = useQuery({
    enabled: Boolean(account && client),
    queryKey: ["put-to-work-venues", account],
    staleTime: 0,
    queryFn: () =>
      readVenues(client as NonNullable<typeof client>, account as Address, [
        USDC,
        WETH,
      ]),
  });

  const wallet = balances.data?.wallet ?? 0n;
  const idle = balances.data?.idle ?? 0n;
  const working = (venues.data?.positions ?? []).reduce(
    (sum, p) =>
      p.asset.toLowerCase() === USDC.toLowerCase() ? sum + p.supplied : sum,
    0n,
  );
  // What a fill may take: everything the account will hold once this batch has run. The working
  // side counts because a fill is covered out of the receipt, not only out of idle tokens.
  const ceiling = wallet + idle + working;

  const reading = balances.isPending || venues.isPending;
  const ready = Boolean(account && address && client) && ceiling > 0n;

  async function run() {
    if (!(client && account && address && ceiling > 0n)) {
      throw new Error("There is nothing to put to work");
    }

    // **Every market, not the permitted ones.** `readVenues` derives permits from logs, and read
    // before this batch a fresh account has none — so a mandate built from that list would name no
    // venues and a fill could only be paid out of idle tokens. This batch permits every market, so
    // by the time anyone can fill, the permits are on chain.
    const receipts = venues.data?.positions ?? [];
    const byPool = new Map<string, SwapMandate["venues"][number]>();
    for (const p of receipts) {
      const key = p.pool.toLowerCase();
      const existing = byPool.get(key) ?? {
        pool: p.pool,
        receipt0: zeroAddress as Address,
        receipt1: zeroAddress as Address,
        kind: p.sharePriced ? ReceiptKind.SharePriced : ReceiptKind.Rebasing,
      };
      if (p.asset.toLowerCase() === USDC.toLowerCase()) {
        existing.receipt0 = p.receipt;
      } else {
        existing.receipt1 = p.receipt;
      }
      byPool.set(key, existing);
    }
    const venueList = [...byPool.values()];

    const mandate: SwapMandate = {
      maker: account,
      token0: USDC,
      token1: WETH,
      feeBps: FEE_BPS,
      maxOut0: ceiling,
      // Whatever the account holds of the other side. Naming more than that would be a ceiling the
      // ledger cannot honour, which is a quote that reverts at fill time.
      maxOut1: balances.data?.weth ?? 0n,
      expiry: BigInt(Math.floor(Date.now() / 1000)) + LIFETIME_SECONDS,
      agent: zeroAddress as Address,
      salt: `0x${Date.now().toString(16).padStart(64, "0")}` as `0x${string}`,
      venues: venueList,
    };

    // The live contract's own hash, against the bytes about to be shipped. An encoding wrong by one
    // field ships successfully under a hash nobody looks up, so this is checked rather than trusted.
    const app = mandateSwapAddress(ARBITRUM_ONE) as Address;
    const theirs = await client.readContract({
      abi: MANDATE_SWAP_ABI,
      address: app,
      args: [mandate],
      functionName: "mandateHash",
    });
    if (String(theirs).toLowerCase() !== mandateHash(mandate).toLowerCase()) {
      throw new Error(
        "The mandate this app encodes is not the one the contract hashes. Nothing was sent.",
      );
    }

    const tokens: Address[] = [USDC, WETH];
    const amounts: bigint[] = [ceiling, balances.data?.weth ?? 0n];
    for (const v of venueList) {
      for (const [receipt, cap] of [
        [v.receipt0, ceiling],
        [v.receipt1, balances.data?.weth ?? 0n],
      ] as const) {
        if (receipt !== zeroAddress) {
          tokens.push(receipt as Address);
          amounts.push(cap);
        }
      }
    }
    const setup = mandateSetupCalls(
      ARBITRUM_ONE,
      app,
      mandate,
      tokens,
      amounts,
    );

    send.sendCalls({
      calls: [
        // `open` has no access control and returns the existing address rather than reverting, so
        // this is skipped for the gas rather than for correctness.
        ...(opened || !factory
          ? []
          : [
              {
                to: factory,
                data: encodeFunctionData({
                  abi: factoryAbi,
                  functionName: "open",
                  args: [address as Address],
                }),
              },
            ]),
        ...(armed
          ? []
          : [
              {
                to: account,
                data: encodeFunctionData({
                  abi: accountWriteAbi,
                  functionName: "setAgent",
                  args: [HELICO_AGENT as Address],
                }),
              },
              ...MARKETS.map((m) => ({
                to: account,
                data: encodeFunctionData({
                  abi: accountWriteAbi,
                  functionName: "permitVenue",
                  args: [m.pool as Address, true],
                }),
              })),
            ]),
        // The wallet's whole balance. "All my assets" is the request, and a number typed into a box
        // is the thing this card exists to remove.
        ...(wallet > 0n
          ? [
              {
                to: USDC,
                data: encodeFunctionData({
                  abi: erc20Abi,
                  functionName: "transfer",
                  args: [account, wallet],
                }),
              },
            ]
          : []),
        // The approvals and the ship, as the account. They go to **Aqua**, never to a Helico
        // contract, and only for what is shipped: an allowance to our own contracts would be
        // custody, would outlive the mandate, and would survive `dock`.
        {
          to: account,
          data: encodeFunctionData({
            abi: accountBatchAbi,
            functionName: "executeBatch",
            args: [
              setup.map((c) => ({
                target: c.to as Address,
                value: 0n,
                data: c.data as `0x${string}`,
              })),
            ],
          }),
        },
      ],
    });
  }

  const done = batch.data?.status === "success";
  const pending = send.isPending || batch.isLoading;
  const failed = send.error ?? batch.error;
  const receipt = batch.data?.receipts?.[0]?.transactionHash;
  const link = receipt ? explorerTx(CHAIN_ID, receipt) : undefined;

  return (
    <div
      className={cn(
        "w-full",
        plain ? "" : "mt-3 max-w-md rounded-xl border p-4",
      )}
      data-testid="put-to-work"
    >
      <p className="font-medium text-sm">Put everything to work</p>
      <p className="mt-1 text-[11.5px] text-soft leading-relaxed">
        One signature. The same money is quotable on 1inch Aqua and earning in a
        lending market at the same time.
      </p>

      <div className="mt-3 flex flex-col gap-2 border-t pt-3 text-[11.5px]">
        {/* **Nothing here asserts a zero while it is still reading.** The funding line said "your
            wallet holds none" during the read, because an undefined balance falls back to zero and
            zero has a sentence of its own. A balance nobody has fetched is not a balance of
            nothing, and this card is read by somebody deciding whether to press a button. */}
        <Line
          done={armed}
          label="Arm the account"
          detail={
            armed
              ? "already done"
              : `name the agent, allow ${MARKETS.length} markets`
          }
        />
        <Line
          done={!reading && wallet === 0n}
          label="Move your USDC in"
          detail={
            reading
              ? "reading your wallet…"
              : wallet > 0n
                ? `${usdc(wallet)} USDC from your wallet`
                : idle + working > 0n
                  ? "already in"
                  : "your wallet holds none"
          }
        />
        <Line
          label="Ship the position"
          detail={
            reading
              ? "reading the account…"
              : `up to ${usdc(ceiling)} USDC quotable on Aqua`
          }
        />
        {/* Not in this batch, and it does not pretend to be. */}
        <Line
          label="Put it to work"
          detail="the agent does this, into whichever market pays most"
          theirs
        />
      </div>

      {canBatch ? (
        <>
          <Button
            className="mt-4 w-full"
            disabled={!ready || pending || reading}
            onClick={() => {
              setRefused(null);
              run().catch((e: unknown) =>
                setRefused(
                  e instanceof Error ? e.message : "Something stopped it.",
                ),
              );
            }}
          >
            {pending ? (
              <>
                <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                Signing…
              </>
            ) : done ? (
              "Done"
            ) : (
              "Execute"
            )}
          </Button>
          {ceiling === 0n && !reading ? (
            <p className="mt-2 text-[11px] text-faint">
              Nothing to put to work yet. Your wallet and your account both hold
              no USDC.
            </p>
          ) : null}
        </>
      ) : (
        // Not a failure, and not dressed as one. **The fallback is an affordance, not a
        // sentence about one**: the control that moves money in is right here, and the two
        // owner-only setters are the only part that has to happen on another page.
        <div className="mt-4">
          <p className="text-[11.5px] text-soft leading-relaxed">
            This wallet cannot batch calls, so one press cannot do all of it.
            {armed
              ? " Move money in here, and the agent takes it from there."
              : " Arm the account on the limits page first, then move money in here."}
          </p>
          <FundAccount plain />
        </div>
      )}

      {done && link ? (
        <p className="mt-2 text-[11px]">
          <a
            className="tabular font-mono text-soft underline decoration-dotted underline-offset-2 hover:text-ink"
            href={link}
            rel="noopener noreferrer"
            target="_blank"
          >
            {`${receipt?.slice(0, 6)}…${receipt?.slice(-4)}`}
          </a>
        </p>
      ) : null}
      {(refused ?? failed) ? (
        <p className="mt-2 text-[11px] text-[#E5484D] leading-relaxed">
          {(refused ?? failed?.message ?? "").split("\n")[0]}
        </p>
      ) : null}
    </div>
  );
}

/** One line of the breakdown: what it is, what it will do, and whether it is this press's job. */
function Line({
  label,
  detail,
  done = false,
  theirs = false,
}: {
  label: string;
  detail: string;
  done?: boolean;
  theirs?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span
        className={cn(
          "mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full border text-[8px]",
          done
            ? "border-transparent bg-[#1DA66A] text-white"
            : theirs
              ? "border-dashed text-faint"
              : "border-ink/30 text-faint",
        )}
      >
        {done ? <Check className="size-2.5" /> : null}
      </span>
      <span className="min-w-0">
        <span className={cn(done ? "text-soft" : "text-ink")}>{label}</span>
        <span className="text-faint"> · {detail}</span>
      </span>
    </div>
  );
}
