"use client";

import {
  LineChartIcon,
  PanelLeftIcon,
  PenSquareIcon,
  SlidersHorizontalIcon,
  TrashIcon,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { useSWRConfig } from "swr";
import { HISTORY_KEY, SidebarHistory } from "@/components/chat/sidebar-history";
import { SidebarUserNav } from "@/components/chat/sidebar-user-nav";
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
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

export function AppSidebar({ address }: { address: `0x${string}` }) {
  const router = useRouter();
  const pathname = usePathname();
  const navClass = (active: boolean) =>
    cn(
      "h-8 rounded-lg text-[13px] transition-colors duration-150 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
      active
        ? "border border-sidebar-border bg-sidebar-accent/40 text-sidebar-foreground"
        : "text-sidebar-foreground/70",
    );
  const { setOpenMobile, toggleSidebar } = useSidebar();
  const { mutate } = useSWRConfig();
  const [showDeleteAllDialog, setShowDeleteAllDialog] = useState(false);

  const closeMobile = useCallback(() => {
    setOpenMobile(false);
  }, [setOpenMobile]);

  const handleToggleSidebar = useCallback(() => {
    toggleSidebar();
  }, [toggleSidebar]);

  const handleNewChat = useCallback(() => {
    setOpenMobile(false);
    router.push("/chat");
  }, [router, setOpenMobile]);

  const handleShowDeleteAllDialog = useCallback(() => {
    setShowDeleteAllDialog(true);
  }, []);

  const handleDeleteAll = useCallback(() => {
    setShowDeleteAllDialog(false);
    router.replace("/chat");
    mutate(HISTORY_KEY, [], { revalidate: false });

    api.deleteConversations().catch(() => undefined);

    toast.success("All chats deleted");
  }, [mutate, router]);

  return (
    <>
      <Sidebar collapsible="icon">
        <SidebarHeader className="pb-0 pt-3">
          <SidebarMenu>
            <SidebarMenuItem className="flex flex-row items-center justify-between">
              <div className="group/logo relative flex items-center justify-center">
                <SidebarMenuButton
                  asChild
                  className="size-8 !px-0 items-center justify-center group-data-[collapsible=icon]:group-hover/logo:opacity-0"
                  tooltip="Helico"
                >
                  {/* The mark, and it goes to the front door. Getting back to helico.site is
                      what the landing's own links are for. */}
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
                      onClick={handleToggleSidebar}
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
                {/* Both pages, named for what they are. The border marks which one you are on:
                    it used to sit on the only nav item there was, so with two of them it said
                    "these are links" instead of "you are here", which is a decoration rather than
                    a state. */}
                {/* Both pages, named for what they are. "Mandate" used to be the only entry and it
                    named neither: it opened the limits page under a word nobody calls it, while
                    the portfolio was reachable only from inside the chat's own cards. */}
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    className={navClass(pathname === "/")}
                    tooltip="Limits"
                  >
                    <Link href="/" onClick={closeMobile}>
                      <SlidersHorizontalIcon size={16} />
                      <span className="font-medium">Limits</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    className={navClass(pathname.startsWith("/portfolio"))}
                    tooltip="Portfolio"
                  >
                    <Link href="/portfolio" onClick={closeMobile}>
                      <LineChartIcon size={16} />
                      <span className="font-medium">Portfolio</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    className="h-8 rounded-lg text-[13px] text-sidebar-foreground/70 transition-colors duration-150 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                    onClick={handleNewChat}
                    tooltip="New Chat"
                  >
                    <PenSquareIcon className="size-4" />
                    <span className="font-medium">New chat</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    className="rounded-lg text-sidebar-foreground/40 transition-colors duration-150 hover:bg-destructive/10 hover:text-destructive"
                    onClick={handleShowDeleteAllDialog}
                    tooltip="Clear chat history"
                  >
                    <TrashIcon className="size-4" />
                    <span className="text-[13px]">Clear chat</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarHistory />
        </SidebarContent>
        <SidebarFooter className="border-t border-sidebar-border pt-2 pb-3">
          {/* One state, not three. Connecting and signing happen in ConnectGate, which stands in
              front of this whole tree, so by the time the sidebar exists both are done. */}
          <SidebarUserNav address={address} />
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <AlertDialog
        onOpenChange={setShowDeleteAllDialog}
        open={showDeleteAllDialog}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear every chat?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete all
              your chats and remove them from our servers.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteAll}>
              Clear chats
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
