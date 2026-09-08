"use client";

import { useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  EXAMPLE_INTENT,
  EXAMPLE_RECORDED_ON,
  EXAMPLE_REPLY,
  EXAMPLE_SAID,
} from "@/lib/example-exchange";

/**
 * What the app does, shown to somebody who has not connected a wallet.
 *
 * The gate is deliberate — Helico prices a swap against what you actually hold, so there is no
 * honest reduced version of the app itself. But "connect a wallet" as the only thing on the page
 * asks a stranger to spend the first move on trust. This spends it on evidence instead.
 *
 * **It is a recording, and it says so three times**: in the title, on the panel, and next to the
 * button that does nothing. Every number in it is the backend's own answer to the sentence
 * above, not a mock-up — see `lib/example-exchange.ts`. A screenshot of a product that does not
 * do this would be the dishonest version of this component, which is why there is no screenshot.
 */
export function ExampleExchange() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        className="font-medium text-foreground hover:underline"
        onClick={() => setOpen(true)}
        type="button"
      >
        See an example
      </button>

      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent className="max-h-[90vh] gap-0 overflow-y-auto p-0 sm:max-w-lg">
          <DialogHeader className="space-y-1.5 border-b p-6">
            <DialogTitle>A recorded example</DialogTitle>
            <DialogDescription>
              One real exchange with the running backend, captured on{" "}
              {EXAMPLE_RECORDED_ON}. Not a live account, not a quote, and
              nothing here has been signed or sent.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 p-6">
            <div className="flex justify-end">
              <p className="max-w-[80%] rounded-2xl bg-primary px-4 py-2.5 text-primary-foreground text-sm">
                {EXAMPLE_SAID}
              </p>
            </div>

            <p className="max-w-[90%] text-sm leading-relaxed">
              {EXAMPLE_REPLY}
            </p>

            <dl className="space-y-2.5 rounded-xl border bg-muted/40 p-4 text-sm">
              <Row label="Network" value={EXAMPLE_INTENT.chain} />
              <Row
                label="You give"
                value={`${EXAMPLE_INTENT.amountIn} ${EXAMPLE_INTENT.tokenIn.symbol}`}
              />
              <Row label="You get" value={EXAMPLE_INTENT.tokenOut.symbol} />
              <Row
                label="In base units"
                mono
                value={EXAMPLE_INTENT.amountInWei}
              />
              <Row
                label={`${EXAMPLE_INTENT.tokenOut.symbol} address`}
                mono
                value={EXAMPLE_INTENT.tokenOut.address}
              />
            </dl>

            <p className="text-muted-foreground text-xs leading-relaxed">
              The addresses come from a registry committed to the repository,
              not from the model — it can ask a question or be refused, but it
              cannot invent a token. What is missing from this recording is the
              price: that is quoted against what your wallet actually holds, at
              the moment you ask, which is why the app wants a wallet before it
              will answer.
            </p>

            <button
              className="w-full rounded-xl border border-dashed py-3 text-muted-foreground text-sm"
              disabled
              type="button"
            >
              Signing happens in your wallet — nothing to press here
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={
          mono
            ? "break-all text-right font-mono text-xs"
            : "text-right font-medium"
        }
      >
        {value}
      </dd>
    </div>
  );
}
