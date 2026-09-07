import { PageHeader } from "@/components/chat/page-header";
import { MandatePanel } from "@/components/mandate-panel";

export const metadata = { title: "Mandate" };

export default function MandatePage() {
  return (
    <div className="flex h-dvh w-full flex-row overflow-hidden">
      <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto bg-background md:rounded-tl-[12px] md:border-border/40 md:border-t md:border-l">
        <PageHeader />
        <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10">
          <h1 className="font-semibold text-2xl tracking-tight">
            The rules you set
          </h1>
          <p className="mt-2 text-muted-foreground text-sm">
            Helico's agent may keep your position near the market price. It may
            do nothing else. These are the limits it works inside, and you can
            end them at any time without asking anyone.
          </p>
          <MandatePanel />
        </main>
      </div>
    </div>
  );
}
