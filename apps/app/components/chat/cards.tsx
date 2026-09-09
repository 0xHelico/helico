"use client";

import { ArrowUpRight } from "lucide-react";
import Link from "next/link";

import type { Card } from "@/lib/intent";

/**
 * The answer to "what can you do", drawn rather than listed.
 *
 * It used to be four bullets inside four paragraphs, which is the one question nobody reads that
 * way: a person asking it is looking for somewhere to start, and a wall of prose gives them a page
 * to skim instead of a thing to press.
 *
 * Every card comes from the backend, including the symbols on the swap one. That is why this file
 * holds no copy of its own — a token added to the registry is a tag here, and a list written in
 * the browser would be a second one to fall behind.
 */
const style =
  "rounded-2xl border border-border/40 bg-card/50 p-3.5 text-left transition-colors hover:border-border hover:bg-card";

function Face({ card }: { card: Card }) {
  return (
    <>
      <p className="flex items-center gap-1 font-medium text-[12.5px] text-foreground">
        {card.title}
        {/* A path is not a label. The card that navigates says so with the arrow on its name;
            the one that sends a sentence shows the sentence, because that is worth reading. */}
        {card.href ? (
          <ArrowUpRight className="size-3 text-muted-foreground/70" />
        ) : null}
      </p>
      <p className="mt-1 text-[11.5px] text-muted-foreground leading-[1.55]">
        {card.body}
      </p>
      {card.tags?.length ? (
        <div className="mt-2.5 flex flex-wrap gap-1">
          {card.tags.map((tag) => (
            <span
              className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
              key={tag}
            >
              {tag}
            </span>
          ))}
        </div>
      ) : null}
      {card.try ? (
        <span className="mt-2.5 flex items-center gap-1 text-[11px] text-muted-foreground/70">
          <ArrowUpRight className="size-3" />
          {card.try}
        </span>
      ) : null}
    </>
  );
}

export function Cards({
  cards,
  onSend,
}: {
  cards: Card[];
  onSend?: (message: string) => void;
}) {
  if (cards.length === 0) {
    return null;
  }
  return (
    <div className="mt-3 grid gap-2 sm:grid-cols-2">
      {cards.map((card) => {
        // Every card is pressable, in one of the two ways the backend offers: a sentence this chat
        // can answer, or a screen it cannot. Nothing here invents a third — a card whose sentence
        // arrives with nobody listening for it renders as plain text, because a button that looks
        // pressable and does nothing is worse than the paragraph it replaced.
        const sentence = card.try;
        if (sentence && onSend) {
          return (
            <button
              className={style}
              key={card.title}
              onClick={() => onSend(sentence)}
              type="button"
            >
              <Face card={card} />
            </button>
          );
        }
        if (card.href) {
          return (
            <Link className={style} href={card.href} key={card.title}>
              <Face card={card} />
            </Link>
          );
        }
        return (
          <div className={style} key={card.title}>
            <Face card={card} />
          </div>
        );
      })}
    </div>
  );
}
