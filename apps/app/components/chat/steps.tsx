"use client";

import type { Step } from "@/lib/intent";
import { cn } from "@/lib/utils";

/**
 * What ran to produce the answer above it.
 *
 * Each line is a function in `apps/be/internal/swap` that actually executed, in the order it
 * executed, with what it returned. That is the whole reason this is here rather than a spinner
 * with a nice label: a refusal ends on the check that refused it, so the person can see that a
 * token was turned down by a registry lookup and not by a model changing its mind.
 *
 * It is `<details>` rather than state of its own, and it is open by default because the checks
 * are the interesting half of this product. Anyone who disagrees closes it, and the browser
 * remembers nothing, which is the correct amount of memory for this.
 */
export function Steps({ steps }: { steps: Step[] }) {
  if (steps.length === 0) {
    return null;
  }

  const refused = steps.filter((s) => !s.ok).length;

  return (
    <details className="group/steps -mb-0.5" data-testid="steps" open>
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-[11.5px] text-muted-foreground/70 transition-colors hover:text-muted-foreground marker:content-none">
        <span className="transition-transform duration-200 group-open/steps:rotate-90">
          ›
        </span>
        {steps.length} {steps.length === 1 ? "check" : "checks"}
        {refused > 0 ? (
          <span className="text-destructive">· {refused} refused</span>
        ) : null}
      </summary>

      <ul className="mt-1.5 ml-[3px] border-border/40 border-l pl-3">
        {steps.map((step, i) => (
          <li
            className="py-[3px] font-mono text-[11.5px] leading-[1.5]"
            // The position is the identity: a tree arrives whole, is never reordered and never
            // appended to, and two Chain.Token lookups of the same symbol are otherwise
            // indistinguishable — which is exactly what a same-token refusal produces.
            // biome-ignore lint/suspicious/noArrayIndexKey: the list is immutable once rendered
            key={i}
          >
            <span className="text-foreground/80">{step.call}</span>{" "}
            <span className="text-muted-foreground/60">{step.detail}</span>
            <span
              className={cn(
                "ml-1.5",
                step.ok ? "text-muted-foreground/40" : "text-destructive",
              )}
            >
              {step.ok ? "ok" : "refused"}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
