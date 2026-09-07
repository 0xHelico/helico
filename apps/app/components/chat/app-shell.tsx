"use client";

import { Loader2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

/** How long the shell will wait for the session before showing the gate regardless. */
const GRACE_MS = 700;

import { AppSidebar } from "@/components/chat/app-sidebar";
import { ConnectGate } from "@/components/chat/connect-gate";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { useHelicoSession } from "@/hooks/use-helico-session";

/**
 * Everything past the gate.
 *
 * The gate stands until the wallet has both connected and proved itself, because both are
 * needed before the app can say anything true: the first to know whose balance a quote is
 * measured against, the second to keep a conversation to one address.
 *
 * While the session is still being read from the cookie, this renders nothing rather than the
 * gate — a reload should not flash "connect a wallet" at somebody who already has.
 */
export function AppShell({
  children,
  defaultOpen,
}: {
  children: ReactNode;
  defaultOpen: boolean;
}) {
  const session = useHelicoSession();
  // Flips once the grace period is over, whatever the session read is doing.
  const [patient, setPatient] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setPatient(true), GRACE_MS);
    return () => clearTimeout(id);
  }, []);

  // Held only long enough to avoid flashing the gate at somebody who is already signed in. If
  // the answer has not arrived by then the gate is shown anyway — waiting longer is what made
  // this look stuck, and the gate is both honest and actionable while the read finishes.
  if (!(session.knows || patient)) {
    return (
      <div className="flex h-dvh items-center justify-center bg-background">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
        <span className="sr-only">Checking your session</span>
      </div>
    );
  }
  // Narrowed here rather than re-checked below: everything past this point is mounted only for
  // a wallet that has connected and proved itself, so the address is a prop from here on and no
  // component under it has to ask again — or carry a branch for an answer it can never get.
  if (!(session.ready && session.address)) {
    return <ConnectGate />;
  }

  return (
    <SidebarProvider defaultOpen={defaultOpen}>
      <AppSidebar address={session.address} />
      <SidebarInset>{children}</SidebarInset>
    </SidebarProvider>
  );
}
