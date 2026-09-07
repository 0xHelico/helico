"use client";

import type { ReactNode } from "react";
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

  if (!session.knows) {
    return <div className="h-dvh bg-background" />;
  }
  if (!session.ready) {
    return <ConnectGate />;
  }

  return (
    <SidebarProvider defaultOpen={defaultOpen}>
      <AppSidebar />
      <SidebarInset>{children}</SidebarInset>
    </SidebarProvider>
  );
}
