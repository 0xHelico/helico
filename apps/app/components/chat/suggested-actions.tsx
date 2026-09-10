"use client";

import { motion } from "framer-motion";
import { memo, useCallback } from "react";
import { suggestions } from "@/lib/constants";
import { Suggestion } from "../ai-elements/suggestion";

type SuggestedActionsProps = {
  /** Sending is the page's job; this only says which words were chosen. */
  onSelect: (suggestion: string) => void;
  /**
   * Once the conversation has started.
   *
   * The starters used to vanish on the first message, which made them a thing you got one look
   * at. They are the fastest way to reach four of the five actions, and someone who has just
   * asked one question is exactly the person about to ask another — so they stay, as one row of
   * small pills above the composer rather than a block of cards competing with the answer.
   */
  compact?: boolean;
};

function PureSuggestedActions({ compact, onSelect }: SuggestedActionsProps) {
  const suggestedActions = suggestions;
  const handleSuggestionClick = useCallback(
    (suggestion: string) => onSelect(suggestion),
    [onSelect],
  );

  if (compact) {
    return (
      <div
        className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5"
        data-testid="suggested-actions"
        style={{
          msOverflowStyle: "none",
          scrollbarWidth: "none",
          WebkitOverflowScrolling: "touch",
        }}
      >
        {suggestedActions.map((suggestedAction) => (
          <Suggestion
            className="h-auto shrink-0 whitespace-nowrap rounded-full border border-border/50 bg-card/30 px-3 py-1.5 text-[11.5px] text-muted-foreground transition-colors duration-150 hover:bg-card/60 hover:text-foreground"
            key={suggestedAction}
            onClick={handleSuggestionClick}
            suggestion={suggestedAction}
          >
            {suggestedAction}
          </Suggestion>
        ))}
      </div>
    );
  }

  return (
    <div
      className="flex w-full gap-2.5 overflow-x-auto pb-1 sm:grid sm:grid-cols-2 sm:overflow-visible"
      data-testid="suggested-actions"
      style={{
        msOverflowStyle: "none",
        scrollbarWidth: "none",
        WebkitOverflowScrolling: "touch",
      }}
    >
      {suggestedActions.map((suggestedAction, index) => (
        <motion.div
          animate={{ opacity: 1, y: 0 }}
          className="min-w-[200px] shrink-0 sm:min-w-0 sm:shrink"
          exit={{ opacity: 0, y: 16 }}
          initial={{ opacity: 0, y: 16 }}
          key={suggestedAction}
          transition={{
            delay: 0.06 * index,
            duration: 0.4,
            ease: [0.22, 1, 0.36, 1],
          }}
        >
          <Suggestion
            className="h-auto w-full whitespace-nowrap rounded-xl border border-border/50 bg-card/30 px-4 py-3 text-left text-[12px] leading-relaxed text-muted-foreground transition-all duration-200 sm:whitespace-normal sm:p-4 sm:text-[13px] hover:-translate-y-0.5 hover:bg-card/60 hover:text-foreground hover:shadow-[var(--shadow-card)]"
            onClick={handleSuggestionClick}
            suggestion={suggestedAction}
          >
            {suggestedAction}
          </Suggestion>
        </motion.div>
      ))}
    </div>
  );
}

export const SuggestedActions = memo(PureSuggestedActions);
