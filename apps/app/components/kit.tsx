import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** One surface. Everything on the page sits in one of these, so nothing floats. */
export function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-2xl border border-line bg-white p-4 sm:p-5",
        className,
      )}
    >
      {children}
    </section>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="font-medium text-[15px] text-ink">{children}</h2>;
}

/**
 * A number and what it is. `tabular` because a figure that shifts sideways as it updates is a
 * figure nobody can compare against the one under it.
 */
export function StatTile({
  name,
  value,
  note,
  tint,
}: {
  name: string;
  value: string;
  note?: string;
  tint?: string;
}) {
  return (
    <div className={cn("rounded-xl p-4", tint ?? "bg-shade")}>
      <div className="text-[11.5px] text-soft">{name}</div>
      <div className="tabular mt-1 font-medium text-[19px] text-ink tracking-tight">
        {value}
      </div>
      {note ? (
        <div className="tabular mt-1 text-[11px] text-faint">{note}</div>
      ) : null}
    </div>
  );
}

/**
 * Nothing here, and why.
 *
 * Empty is an answer on this page rather than a failure — a wallet with no mandates is a fact,
 * and one only an indexer can state. So it gets a sentence rather than a dash.
 */
export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 py-8 text-center">
      <p className="max-w-sm text-[12.5px] text-soft leading-relaxed">
        {children}
      </p>
    </div>
  );
}

/** A failure, with the way out. An error without a retry is a dead end wearing a message. */
export function ErrorState({
  what,
  detail,
  onRetry,
}: {
  what: string;
  detail?: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-2 py-8 text-center">
      <p className="text-[12.5px] text-soft">Could not read {what}.</p>
      {detail ? (
        <p className="max-w-sm font-mono text-[11px] text-faint">{detail}</p>
      ) : null}
      <button
        className="mt-1 rounded-full border border-line px-4 py-1.5 text-[12px] text-ink hover:bg-shade"
        onClick={onRetry}
        type="button"
      >
        Try again
      </button>
    </div>
  );
}

/** Waiting. A shape the size of the answer, so the page does not jump when it arrives. */
export function Loading({ className }: { className?: string }) {
  return (
    <div
      className={cn("animate-pulse rounded-xl bg-shade", className ?? "h-24")}
    />
  );
}

/**
 * A statement that cannot be checked yet, said plainly.
 *
 * Nothing of ours is deployed. A panel that spins forever while no contract exists is
 * indistinguishable from one that is broken, and a panel that invents a figure is the failure
 * the rules name directly. This is the third option.
 */
export function NotDeployed({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-line border-dashed bg-shade p-4">
      <p className="text-[12px] text-soft leading-relaxed">{children}</p>
    </div>
  );
}
