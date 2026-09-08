import Link from "next/link";
import { AccountControls } from "@/components/account-controls";
import { Asks, Grants } from "@/components/capabilities";
import { PageHeader } from "@/components/chat/page-header";
import { PortfolioSummary } from "@/components/portfolio-summary";

export const metadata = { title: "Helico" };

/**
 * The front door.
 *
 * It used to be the conversation, which meant the first thing anyone saw was a box offering to
 * swap — and Helico is not a swap tool.
 *
 * The order is facts, then offer, then controls. Your account and what it may spend are true
 * right now and readable by anyone; what the agent *may* be allowed to do is a list of mostly
 * unbuilt things, and leading with it put five greyed-out rows above the fold and the product
 * below it. Each section is one card with one title, so the page has one rhythm rather than a
 * heading, a dashed row, a white card and a table all claiming the same level.
 */
export default function Page() {
  return (
    <div className="flex h-dvh w-full flex-row overflow-hidden">
      <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto bg-background md:rounded-tl-[12px] md:border-border/40 md:border-t md:border-l">
        <PageHeader />
        <main className="mx-auto w-full max-w-3xl flex-1 px-5 py-12">
          <header className="max-w-2xl">
            <h1 className="font-semibold text-3xl tracking-tight">
              An agent, and the limits it works inside
            </h1>
            <p className="mt-3 text-[14px] text-soft leading-relaxed">
              It decides inside a confidential enclave, and every call it can
              make ends at your own account. A wrong decision costs a
              transaction, never your funds.
            </p>
          </header>

          <PortfolioSummary />

          <section className="mt-10">
            <h2 className="font-medium text-[15px] text-ink">
              What it may be allowed to do
            </h2>
            <p className="mt-1.5 text-[12.5px] text-soft">
              One is wired to a contract. The rest are the direction.
            </p>
            <Grants />
          </section>

          <section className="mt-10" id="mandate">
            <h2 className="font-medium text-[15px] text-ink">
              The limits you set
            </h2>
            <p className="mt-1.5 text-[12.5px] text-soft">
              Owner-only and on chain. Together they are the whole of the
              agent's reach.
            </p>
            <AccountControls />
          </section>

          <section className="mt-10 pb-8">
            <h2 className="font-medium text-[15px] text-ink">
              What you can ask it
            </h2>
            <p className="mt-1.5 text-[12.5px] text-soft">
              Said once, signed by you, in the{" "}
              <Link
                className="underline underline-offset-2 hover:text-ink"
                href="/chat"
              >
                conversation
              </Link>
              .
            </p>
            <Asks />
          </section>
        </main>
      </div>
    </div>
  );
}
