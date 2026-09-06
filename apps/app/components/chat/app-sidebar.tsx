"use client";

import { PanelLeftIcon, PenSquareIcon, TrashIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { useSWRConfig } from "swr";
import { HISTORY_KEY, SidebarHistory } from "@/components/chat/sidebar-history";
import { SidebarUserNav } from "@/components/chat/sidebar-user-nav";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useHelicoSession } from "@/hooks/use-helico-session";
import { api } from "@/lib/api";

export function AppSidebar() {
  const router = useRouter();
  const { setOpenMobile, toggleSidebar } = useSidebar();
  const { mutate } = useSWRConfig();
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const session = useHelicoSession();

  const closeMobile = useCallback(() => setOpenMobile(false), [setOpenMobile]);

  const handleNewChat = useCallback(() => {
    setOpenMobile(false);
    router.push("/");
  }, [router, setOpenMobile]);

  const handleDeleteAll = useCallback(async () => {
    setConfirmDeleteAll(false);
    router.replace("/");
    await api.deleteConversations().catch(() => undefined);
    await mutate(HISTORY_KEY, [], { revalidate: false });
  }, [mutate, router]);

  return (
    <>
      <Sidebar collapsible="icon">
        <SidebarHeader className="pt-3 pb-0">
          <SidebarMenu>
            <SidebarMenuItem className="flex flex-row items-center justify-between">
              <div className="group/logo relative flex items-center justify-center">
                <SidebarMenuButton
                  asChild
                  className="size-8 items-center justify-center !px-0 group-data-[collapsible=icon]:group-hover/logo:opacity-0"
                  tooltip="Helico"
                >
                  {/* The logo goes to a new chat. helico.site is a link in the footer's job. */}
                  <Link href="/" onClick={closeMobile}>
                    <Image
                      alt=""
                      className="rounded"
                      height={18}
                      src="/brand/mark.webp"
                      width={18}
                    />
                  </Link>
                </SidebarMenuButton>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <SidebarMenuButton
                      className="pointer-events-none absolute inset-0 size-8 opacity-0 group-data-[collapsible=icon]:pointer-events-auto group-data-[collapsible=icon]:group-hover/logo:opacity-100"
                      onClick={toggleSidebar}
                    >
                      <PanelLeftIcon className="size-4" />
                    </SidebarMenuButton>
                  </TooltipTrigger>
                  <TooltipContent className="hidden md:block" side="right">
                    Open sidebar
                  </TooltipContent>
                </Tooltip>
              </div>
              <div className="group-data-[collapsible=icon]:hidden">
                <SidebarTrigger className="text-sidebar-foreground/60 transition-colors duration-150 hover:text-sidebar-foreground" />
              </div>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup className="pt-1">
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    className="h-8 rounded-lg border border-sidebar-border text-[13px] text-sidebar-foreground/70 transition-colors duration-150 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                    onClick={handleNewChat}
                    tooltip="New chat"
                  >
                    <PenSquareIcon className="size-4" />
                    <span className="font-medium">New chat</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    className="h-8 rounded-lg text-[13px] text-sidebar-foreground/70 transition-colors duration-150 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                    tooltip="Mandate"
                  >
                    <Link href="/mandate" onClick={closeMobile}>
                      <span className="font-medium">Mandate</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                {session.ready ? (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      className="rounded-lg text-sidebar-foreground/40 transition-colors duration-150 hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => setConfirmDeleteAll(true)}
                      tooltip="Delete all conversations"
                    >
                      <TrashIcon className="size-4" />
                      <span className="text-[13px]">Delete all</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ) : null}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarHistory signedIn={session.ready} />
        </SidebarContent>

        <SidebarFooter className="border-sidebar-border border-t pt-2 pb-3">
          {session.address ? (
            session.ready ? (
              <SidebarUserNav
                address={session.address}
                onSignOut={session.signOut}
              />
            ) : (
              <div className="px-1 group-data-[collapsible=icon]:hidden">
                <Button
                  className="w-full"
                  disabled={session.signing}
                  onClick={session.signIn}
                  size="sm"
                  variant="outline"
                >
                  {session.signing
                    ? "Check your wallet…"
                    : "Sign in to save chats"}
                </Button>
                {session.error ? (
                  <p className="mt-2 text-destructive text-xs">
                    {session.error}
                  </p>
                ) : null}
              </div>
            )
          ) : (
            <div className="px-1 group-data-[collapsible=icon]:hidden">
              <appkit-button balance="hide" />
            </div>
          )}
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <AlertDialog onOpenChange={setConfirmDeleteAll} open={confirmDeleteAll}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete every conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              This cannot be undone. It removes the conversations this wallet
              has saved. It does not touch your funds, your position, or any
              mandate.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteAll}>
              Delete all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
