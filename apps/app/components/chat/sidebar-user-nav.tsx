"use client";

import { useAppKit } from "@reown/appkit/react";
import { ChevronUp } from "lucide-react";
import { useTheme } from "next-themes";
import { useCallback } from "react";
import { useDisconnect } from "wagmi";
import { GeneratedAvatar } from "@/components/generated-avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useHelicoSession } from "@/hooks/use-helico-session";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function SidebarUserNav({ address }: { address: string }) {
  const { setTheme, resolvedTheme } = useTheme();
  const { disconnect } = useDisconnect();
  const { open } = useAppKit();
  const { signOut } = useHelicoSession();
  const handleThemeSelect = useCallback(() => {
    setTheme(resolvedTheme === "dark" ? "light" : "dark");
  }, [resolvedTheme, setTheme]);

  // Disconnecting is both halves: the wallet, and the session cookie that proved it.
  const handleAuthClick = useCallback(() => {
    signOut();
    disconnect();
  }, [disconnect, signOut]);

  // Connected as the wrong address is an ordinary mistake, and disconnecting to fix it is a
  // sharper tool than it needs. The session goes too: the cookie belonged to the old address.
  const handleSwitch = useCallback(async () => {
    await signOut();
    disconnect();
    open({ view: "Connect" });
  }, [disconnect, open, signOut]);

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {
              <SidebarMenuButton
                className="h-8 px-2 rounded-lg bg-transparent text-sidebar-foreground/70 transition-colors duration-150 hover:text-sidebar-foreground data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                data-testid="user-nav-button"
              >
                <GeneratedAvatar
                  className="ring-1 ring-sidebar-border/50"
                  name={address}
                  size={20}
                />
                <span
                  className="truncate font-mono text-[13px]"
                  data-testid="user-email"
                >
                  {short(address)}
                </span>
                <ChevronUp className="ml-auto size-3.5 text-sidebar-foreground/50" />
              </SidebarMenuButton>
            }
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-popper-anchor-width) rounded-lg border border-border/60 bg-card/95 backdrop-blur-xl shadow-[var(--shadow-float)]"
            data-testid="user-nav-menu"
            side="top"
          >
            <DropdownMenuItem
              className="cursor-pointer text-[13px]"
              data-testid="user-nav-item-theme"
              onSelect={handleThemeSelect}
            >
              {`Toggle ${resolvedTheme === "light" ? "dark" : "light"} mode`}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <button
                className="w-full cursor-pointer text-[13px]"
                onClick={handleSwitch}
                type="button"
              >
                Switch wallet
              </button>
            </DropdownMenuItem>
            <DropdownMenuItem asChild data-testid="user-nav-item-auth">
              <button
                className="w-full cursor-pointer text-[13px]"
                onClick={handleAuthClick}
                type="button"
              >
                Disconnect wallet
              </button>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
