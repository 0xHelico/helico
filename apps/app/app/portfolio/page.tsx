import Link from "next/link";
import { PageHeader } from "@/components/chat/page-header";
import { MandatesPanel } from "@/components/mandates-panel";
import { PortfolioHero } from "@/components/portfolio-hero";
import {
  Activity,
  Allocation,
  Holdings,
} from "@/components/portfolio-sections";

export const metadata = { title: "Portfolio | Helico" };

/**
 * Everything true about a wallet right now, on its own page.
 *
 * Split from the mandate page because the two answer different questions and were competing for
 * the same screen: this one is facts already on chain, that one is authority you are about to
 * grant. A summary of this sits at the top of that, and links here.
 */
export default function PortfolioPage() {
  return (
    <div className="flex h-dvh w-full flex-row overflow-hidden">
      <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto bg-background md:rounded-tl-[12px] md:border-border/40 md:border-t md:border-l">
        <PageHeader />
        {/* The page owns the gaps. Each panel used to add its own `mt-4`, so the space between
            two cards depended on which component drew the second one. */}
        <main className="mx-auto w-full max-w-3xl flex-1 px-5 py-10">
          <PortfolioHero />
          {/* `mt-6` because the hero is a sibling of this list rather than a member of it, so
              `space-y` never reached the gap between its card and the first section — the two sat
              flush and read as one long card with a rule through it. */}
          <div className="mt-6 space-y-6">
            <Holdings />
            <Allocation />
            <Activity />
            {/* Back on the page. This is the one panel that shows an indexer answering a question
                the chain cannot — Aqua's balances are private and four levels deep, and no event
                parameter is indexed — and it fell off when the sections replaced the old layout,
                while the chat's own card went on pointing here for exactly this. */}
            <MandatesPanel />
          </div>
          <p className="mt-6 pb-4 text-[11.5px] text-faint">
            Read from the chain and from a subgraph, not from us.{" "}
            <Link
              className="underline underline-offset-2 hover:text-ink"
              href="/"
            >
              The limits you set →
            </Link>
          </p>
        </main>
      </div>
    </div>
  );
}
