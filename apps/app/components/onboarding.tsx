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
 * The gate in front of the first run, and it is deliberately thin.
 *
 * This is mounted on every page for every visitor, so it reads one `localStorage` key and renders
 * nothing. Everything that costs something — the account state, the wallet's capabilities, the
 * batch — lives in `FirstRun` below, which exists only while the dialog is up. Putting those hooks
 * here would have every returning user paying for chain reads on every page to answer a question
 * that was settled the first time they arrived.
 */
export function Onboarding() {
  const { address, isConnected } = useAccount();
  const [needed, setNeeded] = useState(false);

  // In an effect rather than during render: the server has no storage to read and would disagree
  // with the client about what to draw.
  useEffect(() => {
    setNeeded(
      Boolean(isConnected && address) && readOnboarding(address) === null,
    );
  }, [address, isConnected]);

  if (!(needed && address)) return null;
  return <FirstRun address={address} onDone={() => setNeeded(false)} />;
}

/**
 * The first thing a new wallet sees, and the only thing it has to read.
 *
 * Four lines rather than a scroll of legal text, because terms nobody reads are terms nobody
 * agreed to, and a hackathon build asking someone to put real money on Arbitrum One owes them the
 * short version in words they will actually finish. The checkbox is required and the dialog does
 * not close on an outside click or on Escape — an agreement you can dismiss by clicking beside it
 * is not one.
 *
 * **What the switch does, exactly.** On, it nominates Helico's agent and allows all four markets.
 * On a wallet that can batch (EIP-5792) that is one confirmation for the lot, and this stays open
 * until it lands so the person can see what they are confirming. On a wallet that cannot, it is a
 * transaction each, and firing six prompts at somebody who has been here nine seconds is not a
 * feature — it says so and leaves the same button on the limits page.
 *
 * It never means "no signature". `setAgent` and `permitVenue` are owner-only on chain and no batch
 * can stand in for the owner, which is the property that makes a compromised agent harmless. The
 * copy says one confirmation, and one confirmation is what it does.
 */
function FirstRun({
  address,
  onDone,
}: {
  address: `0x${string}`;
  onDone: () => void;
}) {
  const [agreed, setAgreed] = useState(false);
  const [unlockAll, setUnlockAll] = useState(true);
  const [stage, setStage] = useState<"terms" | "unlocking" | "per-step">(
    "terms",
  );
  const unlock = useUnlock();

  // The batch has landed, or it failed. Either way the person is done reading and belongs in the
  // app; a failure leaves the limits page holding the same button.
  const { done, error } = unlock;
  useEffect(() => {
    if (stage === "unlocking" && (done || error)) onDone();
  }, [stage, done, error, onDone]);

  const start = () => {
    if (!agreed) return;
    writeOnboarding(address, unlockAll);
    if (!unlockAll) return onDone();
    if (unlock.canBatch && unlock.ready) {
      unlock.unlock();
      setStage("unlocking");
      return;
    }
    setStage("per-step");
  };

  if (stage === "per-step") {
    return (
      <Dialog open>
        <DialogContent className="sm:max-w-[440px]" showCloseButton={false}>
          <DialogTitle className="text-[16px]">
            Your wallet signs one at a time
          </DialogTitle>
          <DialogDescription className="text-[13px] leading-relaxed">
            It cannot bundle these into a single signature, so turning
            everything on would mean {unlock.steps} separate prompts. Nothing
            has been sent yet. The same button is waiting on the Limits page.
          </DialogDescription>
          <div className="mt-2 flex justify-end">
            <Button onClick={onDone} size="sm">
              Take me to the chat
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  if (stage === "unlocking") {
    return (
      <Dialog open>
        <DialogContent className="sm:max-w-[440px]" showCloseButton={false}>
          <DialogTitle className="text-[16px]">
            Turning everything on
          </DialogTitle>
          <DialogDescription className="text-[13px] leading-relaxed">
            One signature, one transaction. It opens your account, names
            Helico's agent, and allows all {MARKETS.length} markets. Have a look
            at your wallet.
          </DialogDescription>
          <div className="mt-2 flex justify-end">
            <Button onClick={onDone} size="sm" variant="outline">
              Skip for now
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open>
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
            <span className="text-ink">Your wallet is the account.</span> We
            never hold your money and never ask for a key. Everything the agent
            does ends up back in an account that belongs to you.
          </li>
          <li>
            <span className="text-ink">
              The agent only goes where you let it.
            </span>{" "}
            It moves your idle money between the markets you picked. It cannot
            send anything anywhere else, so the worst it can do is move your
            money between your own places.
          </li>
          <li>
            <span className="text-ink">You sign everything.</span> Naming the
            agent and allowing a market are your calls to make, not ours, and
            nobody can make them for you. That is what keeps your money safe
            even if the agent is ever compromised.
          </li>
          <li>
            <span className="text-ink">
              This is a hackathon build on Arbitrum One.
            </span>{" "}
            Real money, no warranty. The code is open, so read it before you
            trust it.
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
              Turn everything on
            </p>
            <p className="mt-1 text-[11.5px] text-soft leading-relaxed">
              Turn everything on now
              {unlock.canBatch
                ? `, with one signature, instead of setting all ${MARKETS.length} markets yourself on the Limits page.`
                : ". Your wallet may want to sign each step, and we will tell you before anything is sent."}
            </p>
          </div>
          <Switch
            aria-label="Turn everything on"
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
