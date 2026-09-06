"use client";

import { ArrowRight, Wallet } from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import { useAccount } from "wagmi";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { SwapCard } from "@/components/swap-card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { suggestions } from "@/lib/constants";
import type { Intent } from "@/lib/intent";

type Turn = {
  id: number;
  from: "user" | "assistant";
  text: string;
  intent?: Intent | null;
};

let nextId = 0;

export default function Page() {
  const { isConnected } = useAccount();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  async function send(message: string) {
    const text = message.trim();
    if (!text || busy) {
      return;
    }

    setDraft("");
    setBusy(true);
    nextId += 1;
    setTurns((t) => [...t, { id: nextId, from: "user", text }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const body = await res.json();
      nextId += 1;
      setTurns((t) => [
        ...t,
        {
          id: nextId,
          from: "assistant",
          text: body.reply ?? body.error ?? "Something went wrong.",
          intent: body.intent ?? null,
        },
      ]);
    } catch {
      nextId += 1;
      setTurns((t) => [
        ...t,
        {
          id: nextId,
          from: "assistant",
          text: "The swap service could not be reached.",
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <a className="flex items-center gap-2" href="https://helico.site">
          <Image alt="" height={26} src="/brand/mark.webp" width={26} />
          <span className="font-bold text-[17px] tracking-tight">helico</span>
        </a>
        {/* Reown renders the connect button and everything behind it. */}
        <appkit-button balance="hide" />
      </header>

      <Conversation className="mx-auto w-full max-w-3xl flex-1 px-4">
        <ConversationContent className="gap-6 py-8">
          {turns.length === 0 ? (
            <ConversationEmptyState
              description="Say what you would like to swap. Nothing moves until you sign it."
              icon={<Wallet className="size-6" />}
              title="Your funds, on autopilot"
            >
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {suggestions.map((s) => (
                  <Button
                    key={s}
                    onClick={() => send(s)}
                    size="sm"
                    variant="outline"
                  >
                    {s}
                  </Button>
                ))}
              </div>
            </ConversationEmptyState>
          ) : null}

          {turns.map((turn) => (
            <Message from={turn.from} key={turn.id}>
              <MessageContent
                className={
                  turn.from === "user"
                    ? "rounded-2xl bg-muted px-4 py-2"
                    : undefined
                }
              >
                <p className="whitespace-pre-wrap">{turn.text}</p>
                {turn.intent ? <SwapCard intent={turn.intent} /> : null}
              </MessageContent>
            </Message>
          ))}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="mx-auto w-full max-w-3xl px-4 pb-6">
        <form
          className="flex items-end gap-2 rounded-2xl border p-2"
          onSubmit={(e) => {
            e.preventDefault();
            send(draft);
          }}
        >
          <Textarea
            className="max-h-40 min-h-11 resize-none border-0 shadow-none focus-visible:ring-0"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(draft);
              }
            }}
            placeholder="Swap half an ETH into USDC"
            value={draft}
          />
          <Button
            disabled={busy || draft.trim() === ""}
            size="icon"
            type="submit"
          >
            <ArrowRight className="size-4" />
            <span className="sr-only">Send</span>
          </Button>
        </form>
        <p className="mt-2 text-center text-muted-foreground text-xs">
          {isConnected
            ? "Connected on Arbitrum One. Helico never moves anything you have not signed."
            : "Connect a wallet to sign what you decide. Reading and asking work without one."}
        </p>
      </div>
    </div>
  );
}
