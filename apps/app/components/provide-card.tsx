"use client";

import {
  ARBITRUM_ONE,
  aquaAddress,
  concentratedStrategy,
  ONE,
  shipCall,
  strategyHash,
  swapVmAddress,
} from "@helico/plugin-1inch";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import {
  type Address,
  formatUnits,
  parseAbi,
  parseUnits,
  zeroAddress,
} from "viem";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useSendTransaction,
  useWriteContract,
} from "wagmi";

import { Card, Loading } from "@/components/kit";
import { TokenMark } from "@/components/token-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CHAIN_ID } from "@/hooks/use-account-state";

const WETH: Address = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const USDC: Address = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const ETH_USD: Address = "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612";

const erc20 = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const feed = parseAbi([
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
]);

/** The band, as a share either side of the current price. Wide enough to survive a demo. */
const BAND_PCT = 20n;
/** What the maker keeps on each fill. 1inch's own instruction reads it in basis points. */
const FEE_BPS = 30;

/**
 * Be the maker, not only the taker.
 *
 * **Why this is the fix for a swap that would not fill.** Nothing in `apps/app` ever called
 * `shipCall` (#346, point 4): the app could take somebody else's Aqua position and never offer one.
 * And on Arbitrum One nobody else's works — six positions hold WETH and USDC and all of them refuse
 * to price (#393). So "there is no liquidity" was a thing only we could fix, and only from a script
 * a person cannot run.
 *
 * **What it gives up, exactly.** An allowance to Aqua for the two amounts committed, and nothing
 * else. `ship` writes a number into Aqua's ledger and moves no token — one wallet's balance can
 * back several positions, and the first fill wins. The approval is for exactly what is shipped
 * rather than unlimited, because a larger one buys nothing: `pull` is bounded by the ledger and
 * outlives the position. Docking ends it, needs nobody's permission, and nothing can block it.
 *
 * The price comes from Chainlink and the band from it, because a maker holding both sides has a
 * price and a maker who typed one has a guess. The curve is 1inch's `concentrate` running in their
 * deployed SwapVM, not arithmetic of ours.
 */
export function ProvideCard() {
  const { address, isConnected, chainId } = useAccount();
  const client = usePublicClient({ chainId: CHAIN_ID });
  const { writeContractAsync } = useWriteContract();
  const { sendTransactionAsync } = useSendTransaction();
  const [typed, setTyped] = useState("10");
  const [hash, setHash] = useState<string | null>(null);

  const price = useReadContract({
    abi: feed,
    address: ETH_USD,
    chainId: CHAIN_ID,
    functionName: "latestRoundData",
  });
  const held = useReadContract({
    abi: erc20,
    address: WETH,
    args: [address ?? zeroAddress],
    chainId: CHAIN_ID,
    functionName: "balanceOf",
    query: { enabled: Boolean(address) },
  });
  const heldUsdc = useReadContract({
    abi: erc20,
    address: USDC,
    args: [address ?? zeroAddress],
    chainId: CHAIN_ID,
    functionName: "balanceOf",
    query: { enabled: Boolean(address) },
  });

  // 1e18-scaled dollars per ETH. The feed answers with eight decimals.
  const ethUsd = price.data ? BigInt(price.data[1]) * 10n ** 10n : null;

  let dollars: bigint | null = null;
  try {
    dollars = typed.trim() === "" ? null : parseUnits(typed.trim(), 0);
  } catch {
    dollars = null;
  }

  // Both sides worth the same, so the position is centred rather than lopsided.
  const usdcSide = dollars === null ? null : dollars * 10n ** 6n;
  const wethSide =
    dollars === null || ethUsd === null || ethUsd === 0n
      ? null
      : (dollars * ONE * ONE) / ethUsd;

  const shortUsdc =
    usdcSide !== null && (heldUsdc.data ?? 0n) < usdcSide
      ? usdcSide - (heldUsdc.data ?? 0n)
      : null;
  const shortWeth =
    wethSide !== null && (held.data ?? 0n) < wethSide
      ? wethSide - (held.data ?? 0n)
      : null;

  const ship = useMutation({
    mutationFn: async () => {
      if (!(client && address && ethUsd && usdcSide && wethSide)) {
        throw new Error("Nothing to ship");
      }
      // Exactly what is committed, not max. Two transactions, then the ship.
      for (const [token, amount] of [
        [USDC, usdcSide],
        [WETH, wethSide],
      ] as const) {
        const approval = await writeContractAsync({
          abi: erc20,
          address: token,
          args: [aquaAddress(ARBITRUM_ONE) as Address, amount],
          chainId: CHAIN_ID,
          functionName: "approve",
        });
        await client.waitForTransactionReceipt({ hash: approval });
      }
      const { strategy } = concentratedStrategy({
        base: { address: WETH, decimals: 18 },
        quote: { address: USDC, decimals: 6 },
        priceMin: (ethUsd * (100n - BAND_PCT)) / 100n,
        priceMax: (ethUsd * (100n + BAND_PCT)) / 100n,
        feeBps: FEE_BPS,
        maker: address,
        // Aqua refuses a hash it has seen, so a second position on the same band needs a new one.
        salt: BigInt(Date.now()),
      });
      const call = shipCall(
        ARBITRUM_ONE,
        strategy,
        [WETH, USDC],
        [wethSide, usdcSide],
      );
      const sent = await sendTransactionAsync({
        to: call.to as Address,
        data: call.data,
        chainId: CHAIN_ID,
      });
      const receipt = await client.waitForTransactionReceipt({ hash: sent });
      if (receipt.status !== "success") throw new Error("The ship reverted");
      setHash(strategyHash(strategy));
      await Promise.all([held.refetch(), heldUsdc.refetch()]);
    },
  });

  if (!isConnected) return null;
  const onChain = chainId === CHAIN_ID;

  return (
    <Card className="mt-4">
      <p className="font-medium text-[15px] text-ink">Provide liquidity</p>
      <p className="mt-1.5 text-[12.5px] text-soft leading-relaxed">
        Commit both sides to a band around the price and anyone can trade
        against it, priced by 1inch's own concentrate instruction. Your tokens
        stay in your wallet: Aqua is a ledger, so this writes a number and the
        approval is for exactly what you commit.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="text-[12.5px] text-soft">$</span>
        <Input
          aria-label="How many dollars a side"
          className="h-9 max-w-[6rem] border-line font-mono text-[12.5px]"
          inputMode="numeric"
          onChange={(e) => setTyped(e.target.value)}
          value={typed}
        />
        <span className="text-[12.5px] text-soft">a side</span>
        <Button
          disabled={
            !onChain ||
            ship.isPending ||
            dollars === null ||
            dollars <= 0n ||
            shortUsdc !== null ||
            shortWeth !== null
          }
          onClick={() => ship.mutate()}
          size="sm"
        >
          {ship.isPending ? "Shipping…" : "Ship it"}
        </Button>
      </div>

      {price.isPending || held.isPending || heldUsdc.isPending ? (
        <Loading className="mt-3 h-12" />
      ) : (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[11.5px]">
          <dt className="text-faint">You commit</dt>
          <dd className="tabular font-mono text-soft">
            <span className="inline-flex items-center gap-1.5">
              <TokenMark size={14} symbol="WETH" />
              {wethSide === null ? "—" : formatUnits(wethSide, 18)}
            </span>
            {"  ·  "}
            <span className="inline-flex items-center gap-1.5">
              <TokenMark size={14} symbol="USDC" />
              {usdcSide === null ? "—" : formatUnits(usdcSide, 6)}
            </span>
          </dd>
          <dt className="text-faint">Band</dt>
          <dd className="tabular font-mono text-soft">
            {ethUsd === null
              ? "—"
              : `$${Number(formatUnits((ethUsd * (100n - BAND_PCT)) / 100n, 18)).toFixed(0)} to $${Number(formatUnits((ethUsd * (100n + BAND_PCT)) / 100n, 18)).toFixed(0)}`}
          </dd>
          <dt className="text-faint">Fee you keep</dt>
          <dd className="tabular font-mono text-soft">
            {(FEE_BPS / 100).toFixed(2)}%
          </dd>
        </dl>
      )}

      {shortWeth !== null || shortUsdc !== null ? (
        <p className="mt-2 text-[11px] text-destructive">
          This wallet is short{" "}
          {shortWeth !== null ? `${formatUnits(shortWeth, 18)} WETH` : ""}
          {shortWeth !== null && shortUsdc !== null ? " and " : ""}
          {shortUsdc !== null ? `${formatUnits(shortUsdc, 6)} USDC` : ""}.
          Nothing is sent, because the ship would commit what you do not have
          and the first fill would revert.
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
      {hash ? (
        <p className="mt-3 border-line border-t pt-3 text-[11.5px] text-soft leading-relaxed">
          Shipped. It is filed under{" "}
          <span className="font-mono text-ink">{`${hash.slice(0, 10)}…`}</span>{" "}
          on 1inch's SwapVM at{" "}
          <span className="font-mono">{`${swapVmAddress(ARBITRUM_ONE).slice(0, 10)}…`}</span>
          , and the index will carry it within a block or two. Dock the same
          tokens under that hash to end it.
        </p>
      ) : null}
    </Card>
  );
}
