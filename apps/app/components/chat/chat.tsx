"use client";

import { ArrowUpIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSWRConfig } from "swr";
import {
  PromptInput,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { Cards } from "@/components/chat/cards";
import { Greeting } from "@/components/chat/greeting";
import { ModelPicker } from "@/components/chat/model-picker";
import { PageHeader } from "@/components/chat/page-header";
import { HISTORY_KEY } from "@/components/chat/sidebar-history";
import { Steps } from "@/components/chat/steps";
import { SuggestedActions } from "@/components/chat/suggested-actions";
import { ThinkingMessage } from "@/components/chat/thinking-message";
import { Turn } from "@/components/chat/turn";
import { MandateCard } from "@/components/mandate-card";
import { SwapCard } from "@/components/swap-card";
import { useHelicoSession } from "@/hooks/use-helico-session";
import { api, type SwapConfig } from "@/lib/api";
import {
  type Card,
  isIntent,
  isTurnAction,
  type Step,
  type TurnResult,
} from "@/lib/intent";
import { cn } from "@/lib/utils";

type ChatTurn = {
  id: string;
  from: "user" | "assistant";
  text: string;
  /** What the turn produced: a swap to sign, or an action the app already does. */
  intent?: TurnResult | null;
};

let localId = 0;
const nextLocalId = () => `local-${++localId}`;

export function Chat({ conversationId }: { conversationId?: string }) {
  const router = useRouter();
  const { mutate } = useSWRConfig();
  const session = useHelicoSession();
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  // Which model answers, read from the backend rather than from this app's own environment —
  // a name the two could disagree about is a name not worth showing.
  const [swap, setSwap] = useState<SwapConfig | null>(null);
  // The conversation this page writes to. Created on the first message rather than on arrival,
  // so opening the app and leaving does not litter the sidebar.
  const active = useRef<string | undefined>(conversationId);
  // Which conversation the turns on screen already belong to. Without it, creating one and
  // navigating to it re-fetches from the server, and that response — which holds only the
  // question, because the answer has not been written yet — lands after the answer arrives and
  // wipes it off the screen.
  const hydrated = useRef<string | undefined>(undefined);
  // The scroller, so a new turn can be brought into view. Without this the page stayed where it
  // was and a reply arrived below the fold, which reads as nothing having happened.
  const scroller = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let live = true;
    api
      .swapConfig()
      .then((c) => live && setSwap(c))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    active.current = conversationId;
    if (!conversationId) {
      hydrated.current = undefined;
      setTurns([]);
      return;
    }
    if (hydrated.current === conversationId) {
      return;
    }
    let live = true;
    api
      .messages(conversationId)
      .then((messages) => {
        if (!live) {
          return;
        }
        hydrated.current = conversationId;
        setTurns(
          messages.map((m) => ({
            id: m.id,
            from: m.role,
            text: m.body,
            intent: (m.intent as TurnResult | undefined) ?? null,
          })),
        );
      })
      .catch(() => {
        if (live) {
          router.replace("/chat");
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
          hydrated.current = created.id;
          await mutate(HISTORY_KEY);
          // The URL changes without a navigation, which is what the template does too. A real
          // route change would remount this component, throw away the turns already on screen,
          // and re-read a conversation that does not hold the answer yet.
          window.history.replaceState({}, "", `/chat/${created.id}`);
        } catch {
          // Carry on unsaved rather than losing the message.
        }
      }
      await remember("user", text);

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Every turn already on screen, oldest first. Without it "make it two instead" is a
          // sentence about nothing, because each request used to arrive on its own.
          body: JSON.stringify({
            message: text,
            history: turns.map((t) => ({ role: t.from, body: t.text })),
          }),
        });
        const body = await res.json();
        const reply = body.reply ?? body.error ?? "Something went wrong.";
        // A swap stores its intent, as it always has. An action stores its name, in the same
        // field, so a reloaded conversation shows the same card instead of a bare sentence. The
        // checks the backend ran ride along on whichever of those it is, and alone when the turn
        // produced neither — a question and a refusal are exactly the turns whose tree is worth
        // keeping, so storing it only beside a card would drop it where it matters most.
        const steps: Step[] | undefined = Array.isArray(body.steps)
          ? body.steps
          : undefined;
        const cards: Card[] | undefined = Array.isArray(body.cards)
          ? body.cards
          : undefined;
        const produced =
          body.intent ??
          (body.action === "status" ||
          body.action === "revoke" ||
          body.action === "withdraw"
            ? { action: body.action }
            : null);
        const result: TurnResult | null =
          produced || steps || cards
            ? ({
                ...(produced ?? {}),
                ...(steps ? { steps } : {}),
                ...(cards ? { cards } : {}),
              } as TurnResult)
            : null;
        setTurns((t) => [
          ...t,
          {
            id: nextLocalId(),
            from: "assistant",
            text: reply,
            intent: result,
          },
        ]);
        await remember("assistant", reply, result ?? undefined);
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
    // `turns` is here because the request carries them. It is the value from before this
    // message was pushed, which is exactly what history means.
    [busy, mutate, session.ready, turns],
  );

  // Follow the bottom, and keep following while the answer grows.
  //
  // Scrolling once when a turn appears is not enough: a card that reads the chain finishes after
  // the scroll and pushes the reply back under the fold, which is the state this was reported in.
  // So a ResizeObserver watches the content and follows every time it gets taller.
  //
  // What decides whether to follow is the reader's **intent**, not their position. Position was
  // the first attempt and it does not work: a smooth scroll is still animating when the card
  // resizes, so the measurement lands mid-flight and reads as somebody who scrolled away. A wheel
  // or a drag is unambiguous, and a programmatic scroll produces neither.
  const stick = useRef(true);
  const settled = useRef(false);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const release = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    };
    el.addEventListener("wheel", release, { passive: true });
    el.addEventListener("touchmove", release, { passive: true });
    return () => {
      el.removeEventListener("wheel", release);
      el.removeEventListener("touchmove", release);
    };
  }, []);

  useEffect(() => {
    const el = scroller.current;
    const content = el?.firstElementChild;
    // Nothing to follow on an empty screen, where the greeting sits centred instead.
    if (!el || !content || (turns.length === 0 && !busy)) return;

    // A new turn is a reason to come back, whatever was being read before it.
    stick.current = true;
    const follow = () => {
      el.scrollTo({
        top: el.scrollHeight,
        behavior: settled.current ? "smooth" : "auto",
      });
      settled.current = true;
    };

    follow();
    const watch = new ResizeObserver(() => {
      if (stick.current) follow();
    });
    watch.observe(content);
    return () => watch.disconnect();
  }, [turns.length, busy]);

  const handleSubmit = useCallback(
    (message: PromptInputMessage) => {
      send(message.text ?? draft);
    },
    [draft, send],
  );

  const empty = turns.length === 0;

  return (
    <div className="flex h-dvh w-full flex-row overflow-hidden">
      {/* The template's chat surface: one background against the sidebar, with the rounded,
          bordered edge that makes it read as a panel rather than a seam. */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background md:rounded-tl-[12px] md:border-border/40 md:border-t md:border-l">
        <PageHeader />

        <div className="relative flex-1">
          {empty ? (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
              <Greeting />
            </div>
          ) : null}
          <div
            className="absolute inset-0 touch-pan-y overflow-y-auto"
            ref={scroller}
          >
            <div className="mx-auto flex min-h-full min-w-0 max-w-4xl flex-col gap-5 px-2 py-6 md:gap-7 md:px-4">
              {turns.map((turn) => (
                <Turn from={turn.from} key={turn.id}>
                  {turn.intent?.steps ? (
                    <Steps steps={turn.intent.steps} />
                  ) : null}
                  <p className="whitespace-pre-wrap text-[13px] leading-[1.65]">
                    {turn.text}
                  </p>
                  {turn.intent?.cards ? (
                    <Cards cards={turn.intent.cards} onSend={send} />
                  ) : null}
                  {isIntent(turn.intent) ? (
                    <SwapCard intent={turn.intent} />
                  ) : isTurnAction(turn.intent) ? (
                    <MandateCard action={turn.intent.action} />
                  ) : null}
                </Turn>
              ))}
              {busy ? <ThinkingMessage /> : null}
            </div>
          </div>
        </div>

        <div className="sticky bottom-0 z-1 mx-auto flex w-full max-w-4xl flex-col gap-2.5 bg-background px-2 pb-3 md:px-4 md:pb-4">
          {empty ? <SuggestedActions onSelect={send} /> : null}

          <PromptInput
            className="[&>div]:rounded-2xl [&>div]:border [&>div]:border-border/30 [&>div]:bg-card/70 [&>div]:shadow-[var(--shadow-composer)] [&>div]:transition-shadow [&>div]:duration-300 [&>div]:focus-within:shadow-[var(--shadow-composer-focus)]"
            onSubmit={handleSubmit}
          >
            <PromptInputTextarea
              className="min-h-24 px-4 pt-3.5 pb-1.5 text-[13px] leading-relaxed placeholder:text-muted-foreground/35"
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Ask anything…"
              value={draft}
            />
            <PromptInputFooter className="px-3 pb-3">
              <PromptInputTools>
                {swap ? <ModelPicker config={swap} /> : null}
              </PromptInputTools>
              <PromptInputSubmit
                className={cn(
                  "h-7 w-7 rounded-xl transition-all duration-200",
                  draft.trim()
                    ? "bg-foreground text-background hover:opacity-85 active:scale-95"
                    : "cursor-not-allowed bg-muted text-muted-foreground/25",
                )}
                disabled={!draft.trim() || busy}
                status={busy ? "submitted" : undefined}
                variant="secondary"
              >
                <ArrowUpIcon className="size-4" />
              </PromptInputSubmit>
            </PromptInputFooter>
          </PromptInput>
        </div>
      </div>
    </div>
  );
}
