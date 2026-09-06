"use client";

import { ChevronUp } from "lucide-react";
import { useTheme } from "next-themes";
import { useCallback } from "react";
import { useDisconnect } from "wagmi";
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

/** A stable colour per address, so the disc is recognisably yours. */
function addressToHue(address: string): number {
  let hash = 0;
  for (const char of address.toLowerCase()) {
    hash = char.charCodeAt(0) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % 360;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function SidebarUserNav({
  address,
  onSignOut,
}: {
  address: string;
  onSignOut: () => void;
}) {
  const { setTheme, resolvedTheme } = useTheme();
  const { disconnect } = useDisconnect();

  const handleThemeSelect = useCallback(() => {
    setTheme(resolvedTheme === "dark" ? "light" : "dark");
  }, [resolvedTheme, setTheme]);

  const handleDisconnect = useCallback(() => {
    onSignOut();
    disconnect();
  }, [disconnect, onSignOut]);

  const hue = addressToHue(address);

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton className="h-8 rounded-lg bg-transparent px-2 text-sidebar-foreground/70 transition-colors duration-150 hover:text-sidebar-foreground data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground">
              <div
                className="size-5 shrink-0 rounded-full ring-1 ring-sidebar-border/50"
                style={{
                  background: `linear-gradient(135deg, oklch(0.55 0.13 ${hue}), oklch(0.4 0.09 ${hue + 40}))`,
                }}
              />
              <span className="truncate font-mono text-[13px]">
                {short(address)}
              </span>
              <ChevronUp className="ml-auto size-3.5 text-sidebar-foreground/50" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-popper-anchor-width) rounded-lg border border-border/60 bg-card/95 shadow-lg backdrop-blur-xl"
            side="top"
          >
            <DropdownMenuItem
              className="cursor-pointer text-[13px]"
              onSelect={handleThemeSelect}
            >
              {`Toggle ${resolvedTheme === "light" ? "dark" : "light"} mode`}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <button
                className="w-full cursor-pointer text-[13px]"
                onClick={handleDisconnect}
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
