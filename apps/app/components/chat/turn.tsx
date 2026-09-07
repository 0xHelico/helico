"use client";

import { MessageContent } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import { SparklesIcon } from "./icons";

/**
 * One turn, in the template's own markup and classes rather than anything of ours: the user's
 * words in a `w-fit` bubble that hugs them, the assistant's beside the mark.
 *
 * The template's PreviewMessage renders AI SDK message parts; ours renders a string and an
 * optional swap card. The wrapper, the bubble and the mark are copied as they are.
 */
export function Turn({
  from,
  children,
}: {
  from: "user" | "assistant";
  children: React.ReactNode;
}) {
  const isAssistant = from === "assistant";

  return (
    <div
      className={cn(
        "group/message w-full",
        !isAssistant && "animate-[fade-up_0.25s_cubic-bezier(0.22,1,0.36,1)]",
      )}
      data-role={from}
      data-testid={`message-${from}`}
    >
      <div
        className={cn(
          isAssistant
            ? "flex items-start gap-3"
            : "flex flex-col items-end gap-2",
        )}
      >
        {isAssistant && (
          <div className="flex h-[calc(13px*1.65)] shrink-0 items-center">
            <div className="flex size-7 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground ring-1 ring-border/50">
              <SparklesIcon size={13} />
            </div>
          </div>
        )}
        {isAssistant ? (
          <div className="flex min-w-0 flex-1 flex-col gap-2">{children}</div>
        ) : (
          <MessageContent
            className="w-fit max-w-[min(80%,56ch)] overflow-hidden break-words rounded-2xl rounded-br-lg border border-border/30 bg-gradient-to-br from-secondary to-muted px-3.5 py-2 text-[13px] leading-[1.65] shadow-[var(--shadow-card)]"
            data-testid="message-content"
          >
            {children}
          </MessageContent>
        )}
      </div>
    </div>
  );
}
