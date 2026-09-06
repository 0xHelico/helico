"use client";

import { ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSWRConfig } from "swr";
import {
  ConversationContent,
  ConversationScrollButton,
  Conversation as ConversationView,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { Greeting } from "@/components/chat/greeting";
import { PageHeader } from "@/components/chat/page-header";
import { HISTORY_KEY } from "@/components/chat/sidebar-history";
import { SwapCard } from "@/components/swap-card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useHelicoSession } from "@/hooks/use-helico-session";
import { api } from "@/lib/api";
import { suggestions } from "@/lib/constants";
import type { Intent } from "@/lib/intent";

type Turn = {
  id: string;
  from: "user" | "assistant";
  text: string;
  intent?: Intent | null;
};

let localId = 0;
const nextLocalId = () => `local-${++localId}`;

export function Chat({ conversationId }: { conversationId?: string }) {
  const router = useRouter();
  const { mutate } = useSWRConfig();
  const session = useHelicoSession();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  // The conversation this page is writing to. It is created on the first message rather than
  // on arrival, so opening the app and leaving does not litter the sidebar.
  const active = useRef<string | undefined>(conversationId);

  useEffect(() => {
    active.current = conversationId;
    if (!conversationId) {
      setTurns([]);
      return;
    }
    let live = true;
    api
      .messages(conversationId)
      .then((messages) => {
        if (!live) {
          return;
        }
        setTurns(
          messages.map((m) => ({
            id: m.id,
            from: m.role,
            text: m.body,
            intent: (m.intent as Intent | undefined) ?? null,
          })),
        );
      })
      .catch(() => {
        if (live) {
          router.replace("/");
        }
      });
    return () => {
      live = false;
    };
  }, [conversationId, router]);

  const send = useCallback(
    async (message: string) => {
      const text = message.trim();
      if (!text || busy) {
        return;
      }
      setDraft("");
      setBusy(true);
      setTurns((t) => [...t, { id: nextLocalId(), from: "user", text }]);

      // Saving is best effort. A backend that is down should cost the history, never the answer.
      const remember = async (
        role: "user" | "assistant",
        body: string,
        intent?: unknown,
      ) => {
        if (!(session.ready && active.current)) {
          return;
        }
        await api
          .append(active.current, { role, body, intent })
          .catch(() => undefined);
      };

      if (session.ready && !active.current) {
        try {
          const created = await api.startConversation(text);
          active.current = created.id;
          await mutate(HISTORY_KEY);
          // replace, not push: the empty page this started from is not somewhere to go back to.
          router.replace(`/chat/${created.id}`);
        } catch {
          // Carry on unsaved rather than losing the message.
        }
      }
      await remember("user", text);

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text }),
        });
        const body = await res.json();
        const reply = body.reply ?? body.error ?? "Something went wrong.";
        setTurns((t) => [
          ...t,
          {
            id: nextLocalId(),
            from: "assistant",
            text: reply,
            intent: body.intent ?? null,
          },
        ]);
        await remember("assistant", reply, body.intent ?? undefined);
        await mutate(HISTORY_KEY);
      } catch {
        setTurns((t) => [
          ...t,
          {
            id: nextLocalId(),
            from: "assistant",
            text: "The swap service could not be reached.",
          },
        ]);
      } finally {
        setBusy(false);
      }
    },
    [busy, mutate, router, session.ready],
  );

  return (
    <div className="flex h-dvh min-w-0 flex-col">
      <PageHeader />

      <ConversationView className="mx-auto w-full max-w-3xl flex-1 px-4">
        <ConversationContent className="gap-6 py-8">
          {turns.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-6">
              <Greeting />
              <div className="flex flex-wrap justify-center gap-2">
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
            </div>
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
      </ConversationView>

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
          {session.isConnected
            ? "Connected on Arbitrum One. Helico never moves anything you have not signed."
            : "Connect a wallet to sign what you decide. Reading and asking work without one."}
        </p>
      </div>
    </div>
  );
}
