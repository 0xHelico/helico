import Link from "next/link";
import { AccountControls } from "@/components/account-controls";
import { PageHeader } from "@/components/chat/page-header";
import { PortfolioSummary } from "@/components/portfolio-summary";

export const metadata = { title: "Limits" };

/**
 * The front door, and it is two controls.
 *
 * It carried sixteen boxes before it carried anything a person could press: six capability cards
 * of which five said "not wired yet", then the limits, then three cards describing sentences the
 * chat already offers as cards of its own. Most of the screen was spent promising and describing.
 *
 * Both lists are now one sentence each. The roadmap sentence still names what is not built, which
 * is the part worth keeping — a page that lists only what works reads as a claim that nothing else
 * was ever intended.
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

          <p className="mt-8 pb-8 text-[12.5px] text-soft leading-relaxed">
            Today the agent moves idle capital between the markets you allow,
            and nothing else. Lending against it, perpetuals, paying for its own
            work and moving across chains are the direction rather than what is
            wired. Ask it anything in the{" "}
            <Link
              className="underline underline-offset-2 hover:text-ink"
              href="/"
            >
              conversation
            </Link>
            .
          </p>
        </main>
      </div>
    </div>
  );
}
