"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { type Address, formatUnits, parseAbi, parseUnits } from "viem";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useWriteContract,
} from "wagmi";

import { Card, Loading } from "@/components/kit";
import { TokenMark } from "@/components/token-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CHAIN_ID, useAccountState } from "@/hooks/use-account-state";
import { ACCOUNT_TOKENS } from "@/lib/account";

const erc20 = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
]);

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * The step between "the agent is allowed to work" and "the agent is working".
 *
 * Naming the agent and allowing the markets is one of three things, and the app had two of them.
 * The other is money in the account: `supplyIdle` moves what the **account** holds, so an enabled
 * account with an empty balance is an agent with nothing to do. The portfolio said "put something
 * into your account" and then offered no way to do it (#387).
 *
 * It is an ordinary ERC-20 transfer, which is why there is no approval and no allowance here. The
 * account is the recipient; nothing is granted to anybody.
 *
 * **USDC only, and the ceiling is deliberate.** Everything the app reads about this account is
 * USDC — `ACCOUNT_TOKENS.idle`, the totals, the allocation — so a WETH deposit would land somewhere
 * these panels cannot show it. The cWETHv3 venue is real and the agent can use it; funding it
 * belongs with the work that teaches the panels about a second asset.
 */
export function FundAccount() {
  const { address, isConnected, chainId } = useAccount();
  const client = usePublicClient({ chainId: CHAIN_ID });
  const { data, refetch } = useAccountState();
  const { writeContractAsync } = useWriteContract();
  const [typed, setTyped] = useState("");

  const account =
    data && data.kind !== "unconfigured"
      ? (data.address as Address)
      : undefined;

  // `useReadContract` rather than `useBalance`: wagmi dropped the token parameter, and reading
  // `balanceOf` is the same request without a version to be wrong about.
  const held = useReadContract({
    abi: erc20,
    address: ACCOUNT_TOKENS.idle,
    args: [address as Address],
    chainId: CHAIN_ID,
    functionName: "balanceOf",
    query: { enabled: Boolean(address) },
  });

  const onChain = chainId === CHAIN_ID;
  const wallet = held.data ?? 0n;

  // Parsed rather than trusted. `parseUnits` throws on anything that is not a number, and a
  // NaN reaching a transfer is a transaction for an amount nobody chose.
  let amount: bigint | null = null;
  try {
    amount = typed.trim() === "" ? null : parseUnits(typed.trim(), 6);
  } catch {
    amount = null;
  }
  const short_ = amount !== null && amount > wallet;

  const send = useMutation({
    mutationFn: async () => {
      if (!(account && client && amount && amount > 0n)) {
        throw new Error("Nothing to send");
      }
      const hash = await writeContractAsync({
        abi: erc20,
        address: ACCOUNT_TOKENS.idle,
        args: [account, amount],
        chainId: CHAIN_ID,
        functionName: "transfer",
      });
      await client.waitForTransactionReceipt({ hash });
      setTyped("");
      await Promise.all([refetch(), held.refetch()]);
    },
  });

  if (!(isConnected && account)) return null;

  return (
    <Card className="mt-4" id="money-in">
      <p className="font-medium text-[15px] text-ink">Money in</p>
      <p className="mt-1.5 text-[12.5px] text-soft leading-relaxed">
        The agent moves what your account holds, so this is the step that gives
        it something to move. An ordinary transfer, with no approval and nothing
        granted to anybody.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-2 rounded-xl border border-line px-2.5 py-1.5">
          <TokenMark size={20} symbol="USDC" />
          <span className="font-medium text-[12.5px] text-ink">USDC</span>
        </span>
        <Input
          aria-label="How much USDC to move in"
          className="h-9 max-w-[9rem] flex-1 border-line font-mono text-[12.5px]"
          inputMode="decimal"
          onChange={(e) => setTyped(e.target.value)}
          placeholder="0.00"
          value={typed}
        />
        <button
          className="rounded-lg px-2 py-1 text-[12px] text-soft transition-colors hover:text-ink"
          onClick={() => setTyped(formatUnits(wallet, 6))}
          type="button"
        >
          Max
        </button>
        <Button
          disabled={
            !onChain ||
            send.isPending ||
            amount === null ||
            amount <= 0n ||
            short_
          }
          onClick={() => send.mutate()}
          size="sm"
        >
          {send.isPending ? "Sending…" : "Move it in"}
        </Button>
      </div>

      {held.isPending ? (
        <Loading className="mt-2.5 h-3 w-40" />
      ) : (
        <p className="tabular mt-2.5 font-mono text-[11px] text-faint">
          {formatUnits(wallet, 6)} USDC in this wallet
        </p>
      )}

      {short_ ? (
        <p className="mt-2 text-[11px] text-destructive">
          More than this wallet holds. Nothing is sent, because the transfer
          would revert and cost you the gas to find out.
        </p>
      ) : null}
      {onChain ? null : (
        <p className="mt-2 text-[11px] text-destructive">
          Switch to Arbitrum One first.
        </p>
      )}
      {send.error ? (
        <p className="mt-2 text-[11px] text-destructive">
          {send.error.message.split("\n")[0]}
        </p>
      ) : null}

      {/* Sending from somewhere else is the other half of this, and for most people the likely
          half: an exchange withdrawal goes to an address, not through a wallet button. The address
          exists before the contract does, which is why this is shown whether or not it is open. */}
      <p className="mt-4 border-line border-t pt-3 text-[11.5px] text-soft leading-relaxed">
        Or send USDC on Arbitrum One to{" "}
        <span className="font-mono text-ink">{short(account)}</span>
        {data?.kind === "unopened"
          ? ". The contract is not deployed there yet, and that is safe: the address is fixed by CREATE2 and the first limit you set deploys it."
          : "."}
      </p>
      <p className="tabular mt-1 select-all break-all font-mono text-[11px] text-faint">
        {account}
      </p>
    </Card>
  );
}
