import { AccountPanel } from "@/components/account-panel";
import { Grants } from "@/components/capabilities";
import { MandatePanel } from "@/components/mandate-panel";
import { MandatesPanel } from "@/components/mandates-panel";
import { PageHeader } from "@/components/page-header";

export const metadata = { title: "Helico" };

/**
 * The front door.
 *
 * It used to be the conversation, which meant the first thing anyone saw was a box offering to
 * swap — and Helico is not a swap tool. It is an agent that may act on your position only inside
 * limits you commit to on chain, so the page reads in that order: what it may be allowed to do,
 * the limits themselves, and only then the sentences you can say to it.
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
            <p className="mt-3 text-[15px] text-muted-foreground leading-relaxed">
              Helico's agent decides inside a confidential enclave, and the
              vault refuses anything your mandate does not allow. The worst a
              wrong decision costs you is an action — never your funds — and you
              can end it at any time without asking anyone.
            </p>
          </header>

          <section className="mt-12">
            <h2 className="font-semibold text-lg tracking-tight">
              What it may be allowed to do
            </h2>
            <p className="mt-1.5 text-muted-foreground text-sm">
              Authority it holds over time. One is real today; the rest are the
              direction, and their switches do not move.
            </p>
            <Grants />
          </section>

          <section className="mt-12" id="account">
            <AccountPanel />
            <MandatesPanel />
          </section>

          <section className="mt-12" id="mandate">
            <h2 className="font-semibold text-lg tracking-tight">
              The limits you set
            </h2>
            <p className="mt-1.5 text-muted-foreground text-sm">
              Committed on chain, enforced by the contract, and revocable by you
              alone.
            </p>
            <MandatePanel />
          </section>
        </main>
      </div>
    </div>
  );
}
