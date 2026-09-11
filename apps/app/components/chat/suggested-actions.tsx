"use client";

import { memo, useCallback } from "react";
import { suggestions } from "@/lib/constants";
import { Suggestion } from "../ai-elements/suggestion";

type SuggestedActionsProps = {
  /** Sending is the page's job; this only says which words were chosen. */
  onSelect: (suggestion: string) => void;
};

/**
 * The starters, as one scrolling row of pills above the composer.
 *
 * **One shape, in every state.** There used to be two: a block of eight cards on an empty chat and
 * a row of pills once the conversation had started. The cards filled the screen and pushed the
 * composer to the bottom edge, so the first thing a person met was a menu rather than a place to
 * type — and the row does the same job in a tenth of the height. Ghoza's call, and the grid is
 * deleted rather than left behind a flag: a branch nothing renders is a branch nobody maintains.
 *
 * They stay after the first message on purpose. They are the fastest way to reach four of the five
 * actions, and somebody who has just asked one question is exactly the person about to ask another.
 */
function PureSuggestedActions({ onSelect }: SuggestedActionsProps) {
  const handleSuggestionClick = useCallback(
    (suggestion: string) => onSelect(suggestion),
    [onSelect],
  );

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
      {suggestions.map((suggestedAction) => (
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

export const SuggestedActions = memo(PureSuggestedActions);
