"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { useUnlock } from "@/hooks/use-unlock";
import { readOnboarding, writeOnboarding } from "@/lib/onboarding";
import { MARKETS } from "@/lib/venues";

/**
 * The first thing a new wallet sees, and the only thing it has to read.
 *
 * Four lines rather than a scroll of legal text, because terms nobody reads are terms nobody
 * agreed to, and a hackathon build asking someone to put real money on Arbitrum One owes them the
 * short version in words they will actually finish. The checkbox is required and the dialog does
 * not close on an outside click — an agreement you can dismiss by clicking beside it is not one.
 *
 * **What the switch does, exactly.** On, it nominates Helico's agent and allows all four markets.
 * On a wallet that can batch (EIP-5792) that is one confirmation for the lot; on one that cannot,
 * it is a transaction each, and this does not fire six prompts at somebody who has been here for
 * nine seconds — it says so and leaves the same button on the limits page. Off, nothing is set,
 * which is the state the limits page exists for.
 *
 * It never means "no signature". `setAgent` and `permitVenue` are owner-only on chain and no batch
 * can stand in for the owner, which is the property that makes a compromised agent harmless. The
 * copy below says one confirmation, and one confirmation is what it does.
 */
export function Onboarding() {
  const { address, isConnected } = useAccount();
  const [open, setOpen] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [unlockAll, setUnlockAll] = useState(true);
  const [perStep, setPerStep] = useState(false);
  const unlock = useUnlock();

  // Asked once the wallet is known, and only for a wallet that has not answered. Reading is a
  // `localStorage` hit, so it happens in an effect rather than during render, where the server
  // has no storage to read and would disagree with the client about what to draw.
  useEffect(() => {
    if (!(isConnected && address)) {
      setOpen(false);
      return;
    }
    setOpen(readOnboarding(address) === null);
  }, [address, isConnected]);

  const start = () => {
    if (!(agreed && address)) return;
    writeOnboarding(address, unlockAll);
    if (unlockAll && unlock.canBatch && unlock.ready) {
      unlock.unlock();
      setOpen(false);
      return;
    }
    // A wallet without EIP-5792 would ask six times in a row. Saying so beats doing it.
    if (unlockAll) {
      setPerStep(true);
      return;
    }
    setOpen(false);
  };

  if (perStep) {
    return (
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent className="sm:max-w-[440px]" showCloseButton={false}>
          <DialogTitle className="text-[16px]">
            Your wallet asks one at a time
          </DialogTitle>
          <DialogDescription className="text-[13px] leading-relaxed">
            It cannot send several calls in one confirmation, so opening
            everything would be {unlock.steps} separate prompts. Nothing is set
            yet. The same button is on the limits page whenever you want it.
          </DialogDescription>
          <div className="mt-2 flex justify-end gap-2">
            <Button onClick={() => setOpen(false)} size="sm">
              Take me to the chat
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogContent
        className="sm:max-w-[520px]"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        showCloseButton={false}
      >
        <DialogTitle className="text-[17px]">Before you start</DialogTitle>
        <DialogDescription className="sr-only">
          What Helico is, and what it may do with your account.
        </DialogDescription>

        <ul className="mt-1 space-y-2.5 text-[13px] text-soft leading-relaxed">
          <li>
            <span className="text-ink">Your wallet is the account.</span> Helico
            never holds your funds and never asks for a key. Every move ends at
            an account whose owner is you, fixed when it was built.
          </li>
          <li>
            <span className="text-ink">
              The agent's reach is the list you allow.
            </span>{" "}
            It can move idle capital between markets you named, and it is given
            no recipient — so the worst it can do is move your money between
            your own places.
          </li>
          <li>
            <span className="text-ink">You sign everything.</span> Nominating
            the agent and allowing a market are owner-only calls on chain. No
            batch and no relayer can make them for you, which is the whole
            reason a compromised agent is harmless.
          </li>
          <li>
            <span className="text-ink">
              This is a hackathon build on Arbitrum One,
            </span>{" "}
            with real funds and no warranty. The code is open — read it before
            you trust it.
          </li>
        </ul>

        <label className="mt-4 flex cursor-pointer items-start gap-2.5 text-[13px] text-ink">
          <input
            checked={agreed}
            className="mt-0.5 size-4 accent-[var(--helico-on)]"
            onChange={(e) => setAgreed(e.target.checked)}
            type="checkbox"
          />
          <span>I have read this and I agree.</span>
        </label>

        <div className="mt-3 flex items-start justify-between gap-4 rounded-xl border border-line bg-shade p-3.5">
          <div>
            <p className="font-medium text-[13px] text-ink">
              Unlock everything
            </p>
            <p className="mt-1 text-[11.5px] text-soft leading-relaxed">
              Nominate Helico's agent and allow all {MARKETS.length} markets now
              {unlock.canBatch
                ? ", in one confirmation, instead of setting them one at a time on the limits page."
                : ". Your wallet may ask for each one — you will be told before anything is sent."}
            </p>
          </div>
          <Switch
            aria-label="Unlock everything"
            checked={unlockAll}
            className="mt-0.5"
            onCheckedChange={setUnlockAll}
          />
        </div>

        <div className="mt-4 flex justify-end">
          <Button disabled={!agreed} onClick={start} size="sm">
            Start
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
