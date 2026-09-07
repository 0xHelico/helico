import Link from "next/link";
import { Capabilities } from "@/components/capabilities";
import { PageHeader } from "@/components/chat/page-header";
import { MandatePanel } from "@/components/mandate-panel";

export const metadata = { title: "Helico" };

/**
 * The front door.
 *
 * It used to be the conversation, which meant the first thing anyone saw was a box offering to
 * swap — and Helico is not a swap tool. What it is is an agent that may act on your position
 * only inside limits you commit to on chain, and that is what this page leads with: the limits
 * first, then what may be asked for, then the conversation as one way in.
 */
export default function Page() {
  return (
    <div className="flex h-dvh w-full flex-row overflow-hidden">
      <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto bg-background md:rounded-tl-[12px] md:border-border/40 md:border-t md:border-l">
        <PageHeader />
        <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10">
          <h1 className="font-semibold text-2xl tracking-tight">
            An agent, and the limits it works inside
          </h1>
          <p className="mt-2 text-muted-foreground text-sm leading-relaxed">
            Helico's agent may keep your Uniswap v4 position near the market
            price. It decides inside a confidential enclave, and the vault
            refuses anything the mandate does not allow — so the worst a wrong
            decision costs you is an action, never your funds. You can end it at
            any time without asking anyone.
          </p>

          <MandatePanel />

          <section className="mt-10">
            <h2 className="font-semibold text-base tracking-tight">
              What it may be asked for
            </h2>
            <p className="mt-1 text-muted-foreground text-sm">
              The ones marked open are answered today. The rest are the
              direction, and are inert until they are not.
            </p>
            <Capabilities />
            <p className="mt-4 text-muted-foreground text-xs">
              Or just{" "}
              <Link
                className="underline underline-offset-2 hover:text-foreground"
                href="/chat"
              >
                say it in a sentence
              </Link>
              .
            </p>
          </section>
        </main>
      </div>
    </div>
  );
}
