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
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  type Address,
  formatUnits,
  parseAbi,
  parseUnits,
  zeroAddress,
} from "viem";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";

import { Card, Loading } from "@/components/kit";
import { TokenMark } from "@/components/token-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { VenueMark } from "@/components/venue-mark";
import { CHAIN_ID, useAccountState } from "@/hooks/use-account-state";
import { ACCOUNT_TOKENS } from "@/lib/account";
import { MARKETS, readVenues } from "@/lib/venues";

const WETH: Address = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const USDC: Address = ACCOUNT_TOKENS.idle;

const accountAbi = parseAbi([
  "struct Call { address target; uint256 value; bytes data; }",
  "function executeBatch(Call[] calls) returns (bytes[])",
]);
const erc20 = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
]);

/** A day. Long enough for a demo, short enough that a forgotten mandate dies on its own. */
const LIFETIME_SECONDS = 86_400n;
const FEE_BPS = 30n;

/**
 * The account is the maker, so the same capital earns and is takeable.
 *
 * **This is the difference between the thesis and two features side by side.** `provide-card.tsx`
 * ships a position backed by tokens in the *wallet*, while `supplyIdle` moves only what the
 * *account* holds — so that version is a maker beside a yield optimiser, two pools of money doing
 * one job each (#396). Here one pool does both: the account holds it, the enclave puts it in
 * whichever market pays most, and when a taker fills, `HelicoMandateSwap._cover` pulls the receipt
 * through Aqua and redeems exactly the shortfall on the way through. Earning and takeable at the
 * same time, which is the thing a vault makes you choose between.
 *
 * **Everything below this button was already proven.** `AccountIsTheMaker.t.sol` has the contracts,
 * `mandateSetupCalls` builds the bytes, and `scripts/check-deployed.ts` runs the whole sequence at
 * the live addresses — ships, quotes, fills, and Aave pays. What was missing was a caller in
 * `apps/`: nothing here had ever called `mandateSetupCalls`.
 *
 * **Why `executeBatch` is right here and wrong in onboarding.** It runs each call as the *account*,
 * and the approvals and the ship must come from the maker — which is the account. The opposite is
 * true of `setAgent` and `permitVenue`, which are owner-only and revert when the account calls
 * itself; `use-unlock.ts` carries that measurement.
 *
 * The approvals go to **Aqua**, never to a Helico contract, and only for what is shipped. An
 * allowance to our own contracts would be custody, would outlive the mandate, and would survive
 * `dock`.
 */
export function ProvideFromAccountCard() {
  const { address, isConnected, chainId } = useAccount();
  const client = usePublicClient({ chainId: CHAIN_ID });
  const { data } = useAccountState();
  const { writeContractAsync } = useWriteContract();
  const [typed, setTyped] = useState("5");
  const [shipped, setShipped] = useState<string | null>(null);

  const account =
    data && data.kind === "open" ? (data.address as Address) : undefined;

  // What the account holds idle, and what it already has at work. Both are spendable by a fill:
  // the idle side directly, the working side through the receipt the venue issued.
  const idle = useQuery({
    enabled: Boolean(account && client),
    queryKey: ["account-idle", account],
    // Fresh on mount, not the app's one-minute default. Everywhere else a minute-old balance is a
    // display that lags; here it decides whether a transaction is sent at all — money that arrived
    // thirty seconds ago is money the ceiling can honour, and this card refused a ceiling the
    // account could cover because it was reading a number from before the deposit.
    staleTime: 0,
    queryFn: async () => {
      const c = client as NonNullable<typeof client>;
      const [usdc, weth] = await Promise.all(
        [USDC, WETH].map((token) =>
          c.readContract({
            abi: erc20,
            address: token,
            args: [account as Address],
            functionName: "balanceOf",
          }),
        ),
      );
      return { usdc: usdc as bigint, weth: weth as bigint };
    },
  });

  // The venues to name in the mandate, derived rather than typed: each permitted market, the
  // receipt it issues for each asset, and whether that receipt is a share count.
  const venues = useQuery({
    enabled: Boolean(account && client),
    queryKey: ["mandate-venues", account],
    // Same reason as above, and one more: a venue permitted a moment ago is a venue the mandate
    // should name, and this is the only read that knows about it.
    staleTime: 0,
    queryFn: () =>
      readVenues(client as NonNullable<typeof client>, account as Address, [
        USDC,
        WETH,
      ]),
  });

  let ceiling: bigint | null = null;
  try {
    ceiling = typed.trim() === "" ? null : parseUnits(typed.trim(), 6);
  } catch {
    ceiling = null;
  }

  // What a fill may take of each side. The WETH ceiling is the same money at the feed-free
  // conversion the account itself uses: there is no oracle in this card, so the WETH side is
  // capped by what the account actually holds rather than by a price.
  const held = venues.data?.positions ?? [];
  const working = held.reduce(
    (sum, p) =>
      p.asset.toLowerCase() === USDC.toLowerCase() ? sum + p.supplied : sum,
    0n,
  );
  const spendableUsdc = (idle.data?.usdc ?? 0n) + working;
  const short =
    ceiling !== null && ceiling > spendableUsdc
      ? ceiling - spendableUsdc
      : null;

  const ship = useMutation({
    mutationFn: async () => {
      if (!(client && account && address && ceiling && ceiling > 0n)) {
        throw new Error("Nothing to ship");
      }
      const positions = venues.data?.positions ?? [];
      // One entry per market, with the receipt for each side. A market with no position in an
      // asset still belongs here: the mandate names where a fill *may* be covered from, and the
      // enclave may have moved money there by the time somebody fills.
      const byPool = new Map<string, SwapMandate["venues"][number]>();
      for (const p of positions) {
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
        // The WETH side is whatever the account holds of it. Naming more than that would be a
        // ceiling the ledger cannot honour, which is a quote that reverts at fill time.
        maxOut1: idle.data?.weth ?? 0n,
        expiry: BigInt(Math.floor(Date.now() / 1000)) + LIFETIME_SECONDS,
        // Anyone may fill. Never an EOA either way: the fill arrives as a callback, so a taker is
        // a contract by construction.
        agent: zeroAddress as Address,
        salt: `0x${Date.now().toString(16).padStart(64, "0")}` as `0x${string}`,
        venues: venueList,
      };

      // The live contract's own hash, against the bytes we are about to ship. An encoding wrong by
      // one field ships successfully under a hash nobody looks up, so this is checked rather than
      // trusted — `check-deployed.ts` holds the same line.
      const app = mandateSwapAddress(ARBITRUM_ONE) as Address;
      const theirs = await client.readContract({
        abi: MANDATE_SWAP_ABI,
        address: app,
        args: [mandate],
        functionName: "mandateHash",
      });
      const ours = mandateHash(mandate);
      if (String(theirs).toLowerCase() !== ours.toLowerCase()) {
        throw new Error(
          "The mandate this app encodes is not the one the contract hashes. Nothing was sent.",
        );
      }

      // The shipped list is the pair plus every receipt, which is what lets a fill be paid out of
      // the lending position rather than only out of idle tokens.
      const tokens: Address[] = [USDC, WETH];
      const amounts: bigint[] = [ceiling, idle.data?.weth ?? 0n];
      for (const v of venueList) {
        for (const [receipt, amount] of [
          [v.receipt0, ceiling],
          [v.receipt1, idle.data?.weth ?? 0n],
        ] as const) {
          if (receipt !== zeroAddress) {
            tokens.push(receipt);
            amounts.push(amount);
          }
        }
      }
      const calls = mandateSetupCalls(
        ARBITRUM_ONE,
        app,
        mandate,
        tokens,
        amounts,
      );

      const hash = await writeContractAsync({
        abi: accountAbi,
        address: account,
        args: [calls.map((c) => ({ target: c.to, value: 0n, data: c.data }))],
        chainId: CHAIN_ID,
        functionName: "executeBatch",
      });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("The batch reverted");
      setShipped(ours);
      await Promise.all([idle.refetch(), venues.refetch()]);
    },
  });

  if (!isConnected) return null;
  if (!account) {
    return (
      <Card className="mt-4">
        <p className="font-medium text-[15px] text-ink">
          Provide from your account
        </p>
        <p className="mt-1.5 text-[12.5px] text-soft leading-relaxed">
          This needs an account. Set either limit and the same call creates it,
          then the money in it can earn and be takeable at once.
        </p>
      </Card>
    );
  }

  const onChain = chainId === CHAIN_ID;
  const marks = [...new Set(held.map((p) => p.pool.toLowerCase()))].map(
    (pool) => MARKETS.find((m) => m.pool.toLowerCase() === pool)?.label,
  );

  return (
    <Card className="mt-4">
      <p className="font-medium text-[15px] text-ink">
        Provide from your account
      </p>
      <p className="mt-1.5 text-[12.5px] text-soft leading-relaxed">
        The same money earns and stays takeable. It sits in whichever market
        pays most, and a fill redeems exactly the shortfall on the way through.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 rounded-xl border border-line px-2.5 py-1.5">
          <TokenMark size={18} symbol="USDC" />
          <span className="font-medium text-[12.5px] text-ink">USDC</span>
        </span>
        <Input
          aria-label="Ceiling a fill may take"
          className="h-9 max-w-[7rem] border-line font-mono text-[12.5px]"
          inputMode="decimal"
          onChange={(e) => setTyped(e.target.value)}
          value={typed}
        />
        <span className="text-[12.5px] text-soft">at most, per fill</span>
        <Button
          disabled={
            !onChain ||
            ship.isPending ||
            venues.isPending ||
            idle.isPending ||
            ceiling === null ||
            ceiling <= 0n ||
            short !== null
          }
          onClick={() => ship.mutate()}
          size="sm"
        >
          {ship.isPending ? "Shipping…" : "Ship from my account"}
        </Button>
      </div>

      {idle.isPending || venues.isPending ? (
        <Loading className="mt-3 h-10" />
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11.5px]">
          <span className="flex items-center gap-1.5">
            <TokenMark size={14} symbol="USDC" />
            <span className="text-faint">Spendable</span>
            <span className="tabular font-mono text-soft">
              {formatUnits(idle.data?.usdc ?? 0n, 6)} idle +{" "}
              {formatUnits(working, 6)} earning
            </span>
          </span>
          {marks.length > 0 ? (
            <span className="flex items-center gap-1.5">
              <span className="text-faint">Covered by</span>
              {marks.map((label) =>
                label ? (
                  <VenueMark key={label} label={label} size={14} />
                ) : null,
              )}
            </span>
          ) : null}
        </div>
      )}

      {short !== null ? (
        <p className="mt-2 text-[11px] text-destructive">
          The account is {formatUnits(short, 6)} USDC short of that ceiling,
          counting what is earning. Nothing is sent, because a fill would ask
          for more than the ledger can honour.
        </p>
      ) : null}
      {onChain ? null : (
        <p className="mt-2 text-[11px] text-destructive">
          Switch to Arbitrum One first.
        </p>
      )}
      {ship.error ? (
        <p className="mt-2 text-[11px] text-destructive">
          {ship.error.message.split("\n")[0]}
        </p>
      ) : null}
      {shipped ? (
        <p className="mt-3 border-line border-t pt-3 text-[11.5px] text-soft leading-relaxed">
          Shipped from your account, under{" "}
          <span className="font-mono text-ink">{`${shipped.slice(0, 10)}…`}</span>
          . The money keeps earning until somebody fills it. Docking ends it and
          needs nobody's permission.
        </p>
      ) : null}
    </Card>
  );
}
