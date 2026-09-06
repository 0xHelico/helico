"use client";

import { PanelLeftIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSidebar } from "@/components/ui/sidebar";

/**
 * The bar above the page. Deliberately almost empty: the account and the navigation live in the
 * sidebar, and a second Connect Wallet button beside the first one is a question about which
 * one is real.
 *
 * The toggle is mobile-only, as in the template — on a desktop the sidebar has its own, and in
 * the collapsed rail the logo turns into one on hover.
 */
export function PageHeader() {
  const { toggleSidebar, state, isMobile } = useSidebar();

  if (state === "collapsed" && !isMobile) {
    return <div className="h-2" />;
  }

  return (
    <header className="flex h-12 items-center gap-2 px-3">
      <Button
        className="md:hidden"
        onClick={toggleSidebar}
        size="icon"
        variant="ghost"
      >
        <PanelLeftIcon className="size-4" />
        <span className="sr-only">Toggle sidebar</span>
      </Button>
    </header>
  );
}
