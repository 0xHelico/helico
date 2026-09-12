"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { type Address, erc20Abi } from "viem";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useWriteContract,
} from "wagmi";
import { FundAccount } from "@/components/fund-account";
import { Glyph } from "@/components/glyph";
import { TokenMark } from "@/components/token-mark";
import { Button } from "@/components/ui/button";
import { VenueMark } from "@/components/venue-mark";
import { CHAIN_ID, totals, useAccountState } from "@/hooks/use-account-state";
import { useUnlock } from "@/hooks/use-unlock";
import {
  AAVE_V3_POOL,
  accountReadAbi,
  accountWriteAbi,
  hasAgent,
} from "@/lib/account";
import { readAccountActivity } from "@/lib/activity";
import { explorerTx } from "@/lib/chain";
import { amountShort as held } from "@/lib/format";
import { amount, readMandates, token, WALLET_TOKENS } from "@/lib/mandates";
import { readVenues, sweepList } from "@/lib/venues";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

/**
 * What the conversation can answer besides a swap.
 *
 * It used to read `HelicoVault`, and with no vault deployed it answered *"No vault address is set
 * yet — set one on the mandate page"*, pointing at a form that page no longer has. A dead end at
 * the end of a question the front page invites you to ask.
 *
 * Every answer here comes from what is actually deployed. **Status** is the account's own state
 * plus the mandates only an indexer can list — which is exactly what "what am I allowed to spend?"
 * means. **Revoke** removes the agent, which is what revoking authority is now: `setAgent(0)` is
 * owner-only, takes effect immediately, and can only ever remove.
 *
 * **Withdraw** is the escape hatch, and it is not the same thing as revoking. Until it existed the
 * empty chat screen offered "Take everything back to my wallet" above a comment promising every
 * sentence there could be answered — and that one went to `revoke`, which removes the agent and
 * leaves every token where it was. Somebody asking for their money got agreement and no money.
 */
export function MandateCard({
  action,
}: {
  action: "status" | "revoke" | "withdraw" | "earn";
}) {
  const { address, isConnected, chainId } = useAccount();
  const client = usePublicClient({ chainId: CHAIN_ID });
  const { data, refetch } = useAccountState();
  const { writeContractAsync } = useWriteContract();

  const account =
    data && data.kind === "open" ? (data.address as Address) : undefined;

  const venue = useReadContract({
    abi: accountReadAbi,
    address: account,
    chainId: CHAIN_ID,
    functionName: "permittedVenue",
    args: [AAVE_V3_POOL],
    query: { enabled: Boolean(account) },
  });

  const mandates = useQuery({
    enabled: Boolean(address),
    queryKey: ["mandates", address],
    queryFn: () => readMandates(address as string),
  });

  // The account's own log, for the transaction that opened it. The same key the portfolio uses, so
  // a reader who has been there already pays nothing for this.
  const own = useQuery({
    enabled: Boolean(account && client),
    queryKey: ["account-activity", account],
    queryFn: () =>
      readAccountActivity(
        client as NonNullable<typeof client>,
        account as Address,
      ),
    retry: false,
    staleTime: 15_000,
  });

  // Up here with the other hooks, not beside the branch that uses it: everything below returns
  // early for a wallet that is not connected or an account that is not read yet, and a hook after
  // one of those runs on some renders and not others.
  const unlock = useUnlock();

  const revoke = useMutation({
    mutationFn: async () => {
      if (!account) throw new Error("No account is open");
      const hash = await writeContractAsync({
        abi: accountWriteAbi,
        address: account,
        chainId: CHAIN_ID,
        functionName: "setAgent",
        args: [ZERO],
      });
      await client?.waitForTransactionReceipt({ hash });
      await refetch();
    },
  });

  // Every token is named, because a contract cannot enumerate what it holds and an unnamed token
  // is a token left behind. Native currency needs no naming — `escape` sweeps it either way.
  //
  // **The list is built here, at the click, from the account's own history.** It used to be two
  // addresses typed into this file, which was correct while Aave was the only market an account
  // could reach. Once capital could sit in Compound or Morpho, or be denominated in WETH, that
  // list swept whatever happened to still be USDC, returned successfully, and left the rest —
  // the way out reporting that it had worked while doing part of the job.
  //
  // Naming the other five would have fixed it until the next venue. `readVenues` reads the
  // markets out of the account's `VenuePermitted` logs and asks each one which receipt it issues,
  // so a venue deployed after this file was written is swept without this file changing.
  const sweep = useMutation({
    mutationFn: async () => {
      if (!account) throw new Error("No account is open");
      if (!client) throw new Error("No chain to read");
      const { positions } = await readVenues(client, account);
      const hash = await writeContractAsync({
        abi: accountWriteAbi,
        address: account,
        chainId: CHAIN_ID,
        functionName: "escape",
        args: [sweepList(positions)],
      });
      await client.waitForTransactionReceipt({ hash });
      await refetch();
    },
  });

  if (!(isConnected && address)) {
    return <Note>Connect a wallet and this reads your account.</Note>;
  }
  if (chainId !== CHAIN_ID) {
    return <Note>Switch to Arbitrum One to read your account.</Note>;
  }
  if (!data) {
    return (
      <Note>
        <span className="flex items-center gap-2">
          <Loader2 className="size-3 animate-spin" /> Reading your account…
        </span>
      </Note>
    );
  }
  if (data.kind === "unconfigured") {
    return (
      <Note>No account factory is deployed, so there is nothing to read.</Note>
    );
  }
  // Earn is the exception, and it is the whole point of the action: somebody asking to start
  // earning before they have an account needs the first step, not a list of what their wallet
  // happens to hold. Every other action here reads an account, so for them this still stands.
  if (data.kind === "unopened" && action !== "earn") {
    return <WalletInstead address={address} />;
  }

  const held = totals(data);
  const nominated = hasAgent(data);
  // Why nothing has moved, which is the question people actually ask. Every input is already on
  // this card; without this line a reader has to infer the cause from four rows of a list.
  //
  // The venue case waits for `false` rather than for "not true": while that read is in flight,
  // claiming the agent has nowhere to put it would be a reason invented out of a pending promise.
  const because = !nominated
    ? "Nobody may move it, so nothing has. Nominate an agent above and it starts."
    : venue.data === false
      ? "The agent has nowhere to put it. Permit a market and it can."
      : held && held.total === 0n
        ? "There is nothing in the account to move. Send it some and the agent takes over."
        : held && held.working === 0n
          ? "Nothing has moved yet. The agent looks every five minutes and only moves when the gain clears the gas."
          : null;
  /**
   * Earn, asked before any of the setup is done, which is when people ask it.
   *
   * The three conditions are the same ones `because` above names, in the same order, because they
   * are the order they have to happen in: nobody may move it, then it has nowhere to go, then
   * there is nothing to move. What is added here is the button for the step that is actually
   * missing — the card used to be a link to a page where a reader had to find the control.
   *
   * `useUnlock` is the same batch the limits page and the first run send, so a market added there
   * is a market permitted from here without this file changing.
   */
  const needsLimits = !nominated || venue.data === false;
  const needsMoney = !needsLimits && held !== null && held.total === 0n;
  // One line each. These are read while deciding what to press, not studied.
  //
  // **"All set" was wrong in both directions at a small balance.** It said the thing was done when
  // the thing cannot happen: the agent moves only when the gain clears the gas, and a balance far
  // under that floor will sit there for ever while the card congratulates it. Measured on the live
  // chain — an account holding 0.5 USDC, fully armed, and nothing had moved in a day.
  //
  // The floor itself is **not** named here, and that is deliberate. It is `minMoveAmount` in the
  // policy the owner seals into the Vault DON; this app cannot read it, and printing a number it
  // cannot verify would be the same mistake one level down. So the sentence says what is true
  // without the figure, and leaves the figure to whoever set it.
  const earnNext = needsLimits
    ? "No agent, and nowhere to put it. Two calls fix both."
    : needsMoney
      ? "Ready, and the account is empty."
      : "Set up. The agent moves when the gain clears the gas, so a small balance may sit a long time.";

  // Oldest first is the end of the list: `readAccountActivity` sorts newest first, and nothing an
  // account did can predate the transaction that created it.
  const opened = own.data?.at(-1);
  const openedAt = opened ? explorerTx(CHAIN_ID, opened.tx) : undefined;

  const live = mandates.data?.rows.filter((m) => m.active) ?? [];
  const spendable = [...(mandates.data?.spendable ?? new Map())].filter(
    ([, value]) => value > 0n,
  );

  return (
    <div className="mt-3 w-full max-w-md rounded-xl border p-4">
      <p className="font-medium text-sm">
        {short(data.address)} · {nominated ? "agent nominated" : "no agent"}
      </p>

      {/* Four labelled rows of prose became four facts you can read at a glance. Each one carries
          the mark of the thing it is about, because a column of words makes a reader parse every
          line before they can tell which fact is which — and this card is answered by a glance
          more often than it is read. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11.5px]">
        <span className="flex items-center gap-1.5">
          <Glyph name="wings" size={13} />
          <span className="text-faint">Agent</span>
          <span className="tabular font-mono text-soft">
            {nominated && data.kind === "open"
              ? short(data.agent as string)
              : "none"}
          </span>
        </span>
        <span className="flex items-center gap-1.5">
          {venue.data === true ? (
            <VenueMark label="Aave v3" size={14} />
          ) : (
            <Glyph name="layers" size={13} />
          )}
          <span className="text-faint">Market</span>
          <span className="text-soft">
            {venue.data === true ? "Aave v3" : "none"}
          </span>
        </span>
        <span className="flex items-center gap-1.5">
          <TokenMark size={14} symbol="USDC" />
          <span className="text-faint">Holding</span>
          <span className="tabular font-mono text-soft">
            {held
              ? `${amount(held.idle, 6)} + ${amount(held.working, 6)}`
              : "0"}
          </span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="text-faint">Mandates</span>
          <span className="tabular font-mono text-soft">
            {mandates.isPending
              ? "…"
              : mandates.error
                ? "unknown"
                : String(live.length)}
          </span>
        </span>
        {/* **The transaction that opened this account, as a link rather than as a sentence.**
            The index used to report it in prose — "the transaction that opened the account has the
            hash 0x0673389b803b0b2a60c828ee0b1a7cb4984f00a0960e4b8b85fa66972181ce61" — sixty-six
            characters nobody can check by reading them. Shortened and pointed at the explorer, it
            is the same fact and one click from being verified.

            The oldest event the account emitted, because the list arrives newest first and an
            account cannot have done anything before the transaction that created it. Absent while
            the log is being read, and absent if it cannot be: a link to nowhere is worse than no
            link, and a hash this app invented would be worse than both. */}
        {opened ? (
          <span className="flex items-center gap-1.5">
            <span className="text-faint">Opened</span>
            {openedAt ? (
              <a
                className="tabular font-mono text-soft underline decoration-dotted underline-offset-2 hover:text-ink"
                href={openedAt}
                rel="noopener noreferrer"
                target="_blank"
              >
                {short(opened.tx)}
              </a>
            ) : (
              <span className="tabular font-mono text-soft">
                {short(opened.tx)}
              </span>
            )}
          </span>
        ) : null}
      </div>

      {action === "earn" ? (
        <div className="mt-3 border-t pt-3">
          <p className="text-[11.5px] text-soft leading-relaxed">{earnNext}</p>
          {needsLimits && unlock.canBatch && unlock.ready ? (
            <Button
              className="mt-3"
              disabled={unlock.pending}
              onClick={unlock.unlock}
              size="sm"
            >
              {unlock.pending
                ? "Setting up…"
                : "Turn everything on with one signature"}
            </Button>
          ) : null}
          {needsLimits && !(unlock.canBatch && unlock.ready) ? (
            <Link
              className="mt-3 inline-block text-[11.5px] underline underline-offset-2 hover:text-ink"
              href="/limit"
            >
              Set them on the limits page
            </Link>
          ) : null}
          {/* The control itself, not a link to it. Money in lives in the conversation now, so the
              step that is missing arrives with the thing that does it.
  
              **Offered whenever the setup is done, not only at exactly zero.** It used to be gated
              on `needsMoney`, so the moment an account held anything at all the card stopped
              offering the one action that would make it work — a person with 0.5 USDC in a
              fully-armed account had no way to add more from the card that is about adding more. */}
          {needsLimits ? null : <FundAccount plain />}
          {unlock.error ? (
            <p className="mt-2 text-[11px] text-destructive">
              {unlock.error.message.split("\n")[0]}
            </p>
          ) : null}
        </div>
      ) : null}

      {action === "status" && because ? (
        <p className="mt-3 border-t pt-3 text-[11.5px] text-soft leading-relaxed">
          {because}
        </p>
      ) : null}

      {spendable.length > 0 ? (
        <>
          <p className="mt-3 text-muted-foreground text-xs">
            Still spendable through those mandates:
          </p>
          <ul className="tabular mt-1 font-mono text-[11.5px] text-muted-foreground">
            {spendable.map(([address_, value]) => {
              const t = token(address_ as string);
              return (
                <li key={address_ as string}>
                  {amount(value as bigint, t.decimals)} {t.symbol}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}

      {action === "withdraw" ? (
        <div className="mt-4 border-t pt-3">
          {held && held.total > 0n ? (
            <>
              <p className="text-muted-foreground text-xs">
                Everything goes to {short(address)}, the address this account
                was built for. The call takes no recipient, so there is nowhere
                else it can send.
              </p>
              {held.working > 0n ? (
                <p className="mt-2 text-muted-foreground text-xs">
                  {amount(held.working, 6)} of it is working, and comes back as
                  Aave&rsquo;s receipt rather than as USDC. That token redeems
                  at Aave for the asset whenever you want it.
                </p>
              ) : null}
              {sweep.isSuccess ? (
                <p className="mt-3 text-xs">
                  Swept. A token that refuses to move would have stopped the
                  rest, so if anything is still here, press it again.
                </p>
              ) : (
                <Button
                  className="mt-3"
                  disabled={sweep.isPending}
                  onClick={() => sweep.mutate()}
                  size="sm"
                  variant="destructive"
                >
                  {sweep.isPending
                    ? "Sending…"
                    : `Send ${amount(held.total, 6)} back to me`}
                </Button>
              )}
              {sweep.error ? (
                <p className="mt-2 text-destructive text-xs">
                  {sweep.error.message.split("\n")[0]}
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-muted-foreground text-xs">
              This account holds nothing, so there is nothing to send back.
            </p>
          )}
        </div>
      ) : null}

      {action === "revoke" ? (
        <div className="mt-4 border-t pt-3">
          {nominated ? (
            <>
              <p className="text-muted-foreground text-xs">
                Removing the agent needs nobody's permission and takes effect at
                once.
              </p>
              {revoke.isSuccess ? (
                <p className="mt-3 text-xs">
                  Removed. Nothing moves without you now.
                </p>
              ) : (
                <Button
                  className="mt-3"
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate()}
                  size="sm"
                  variant="destructive"
                >
                  {revoke.isPending ? "Removing…" : "Remove the agent"}
                </Button>
              )}
              {revoke.error ? (
                <p className="mt-2 text-destructive text-xs">
                  {revoke.error.message.split("\n")[0]}
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-muted-foreground text-xs">
              Nobody is nominated, so there is nothing to revoke.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * What the wallet holds, when the account holds nothing because it does not exist.
 *
 * "Open it and this can answer" was a dead end at the end of a question somebody asked. The
 * account is empty, but the question was about money and the wallet has an answer, so it gives
 * that one and says which it is. The two are never confused: this reads the wallet, and every
 * other number on this card reads the account.
 *
 * Zero balances are dropped. A list of six zeroes is not a fuller answer than a sentence.
 */
function WalletInstead({ address }: { address: Address }) {
  const client = usePublicClient({ chainId: CHAIN_ID });

  const wallet = useQuery({
    enabled: Boolean(client && address),
    queryKey: ["wallet-balances", address],
    staleTime: 15_000,
    queryFn: async () => {
      if (!client) throw new Error("no client");
      const erc20s = Object.entries(WALLET_TOKENS);
      const [native, ...rest] = await Promise.all([
        client.getBalance({ address }),
        ...erc20s.map(([addr]) =>
          client.readContract({
            abi: erc20Abi,
            address: addr as Address,
            args: [address],
            functionName: "balanceOf",
          }),
        ),
      ]);
      const rows: { symbol: string; text: string }[] = [];
      if (native > 0n) {
        rows.push({ symbol: "ETH", text: held(native, 18) });
      }
      rest.forEach((value, i) => {
        const [, t] = erc20s[i];
        if (value > 0n) {
          rows.push({ symbol: t.symbol, text: held(value, t.decimals) });
        }
      });
      return rows;
    },
  });

  return (
    <div className="mt-3 w-full max-w-md rounded-xl border p-4">
      <p className="text-muted-foreground text-xs">
        Your account is not open yet, so it holds nothing. This is what your
        wallet holds.
      </p>

      {wallet.isPending ? (
        <p className="mt-3 flex items-center gap-2 text-muted-foreground text-xs">
          <Loader2 className="size-3 animate-spin" /> Reading it…
        </p>
      ) : wallet.error ? (
        <p className="mt-3 text-muted-foreground text-xs">
          The chain did not answer.
        </p>
      ) : wallet.data && wallet.data.length > 0 ? (
        // Badges rather than rows. These were full-width lines with a `flex-1` between the symbol
        // and the amount, which pinned the number to the far edge — so pairing `USDT` with its
        // balance meant crossing the whole card, three times. A balance is a short fact and reads
        // better as one piece.
        <ul className="mt-3 flex flex-wrap gap-2">
          {wallet.data.map((row) => (
            <li
              className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 py-1 pr-2.5 pl-1"
              key={row.symbol}
            >
              <TokenMark size={18} symbol={row.symbol} />
              <span className="text-[12px] text-muted-foreground">
                {row.symbol}
              </span>
              <span className="tabular numeric text-[13.5px] text-ink">
                {row.text}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-muted-foreground text-xs">
          None of the tokens this works with, and no ETH.
        </p>
      )}

      {/* Not "open the account": there is no separate opening step since #306, which made the
          first limit an owner sets deploy it and removed the button that used to. */}
      <p className="mt-3 text-muted-foreground text-xs">
        <Link className="underline underline-offset-2" href="/limit">
          Set a limit
        </Link>{" "}
        and this answers for the account instead.{" "}
        <Link className="underline underline-offset-2" href="/portfolio">
          Your portfolio
        </Link>{" "}
        has the rest.
      </p>
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-3 rounded-xl border p-4 text-muted-foreground text-xs">
      {children}
    </div>
  );
}
