import { CheckIcon, LockIcon } from "lucide-react";
import Link from "next/link";
import { CAPABILITIES } from "@/lib/capabilities";
import { cn } from "@/lib/utils";

/**
 * What the agent may be asked for, and what it may not yet.
 *
 * The unwired rows are deliberately present and deliberately inert: no link, no hover, and a
 * label saying so. Showing where the product is going is worth something; implying it already
 * arrived is worth losing the submission over, so the difference is in the markup rather than in
 * a sentence somebody has to read.
 */
export function Capabilities() {
  return (
    <ul className="mt-4 grid gap-2">
      {CAPABILITIES.map((c) => {
        const body = (
          <>
            <div className="flex items-center gap-2">
              {c.wired ? (
                <CheckIcon className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <LockIcon className="size-3.5 shrink-0 text-muted-foreground/40" />
              )}
              <span
                className={cn(
                  "font-medium text-[13px]",
                  !c.wired && "text-muted-foreground/50",
                )}
              >
                {c.name}
              </span>
              <span className="ml-auto shrink-0 text-[11px] text-muted-foreground/60">
                {c.wired ? "you can ask for this" : "not wired yet"}
              </span>
            </div>
            <p
              className={cn(
                "mt-1 pl-[22px] text-muted-foreground text-xs leading-relaxed",
                !c.wired && "text-muted-foreground/50",
              )}
            >
              {c.detail}
            </p>
            {c.wired && c.say ? (
              <p className="mt-1.5 pl-[22px] text-[11px] text-muted-foreground/60 italic">
                “{c.say}”
              </p>
            ) : null}
          </>
        );

        return (
          <li key={c.name}>
            {c.wired ? (
              <Link
                className="block rounded-xl border p-3 transition-colors hover:bg-accent/40"
                href="/chat"
              >
                {body}
              </Link>
            ) : (
              <div className="rounded-xl border border-dashed p-3">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
