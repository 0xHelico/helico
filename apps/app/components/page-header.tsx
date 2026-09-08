"use client";

import { useAppKit } from "@reown/appkit/react";
import { useAccount, useDisconnect } from "wagmi";

import { Button } from "@/components/ui/button";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * The bar above the page, and the only place a wallet is connected.
 *
 * It used to hold a toggle for a sidebar, and the connect button lived inside that sidebar with
 * the conversation history. Both went with the chat, so this became the one door — a page with
 * no way to connect a wallet is worse than a page with two.
 *
 * Connecting is optional and always was, more so now: the mandate panel reads any address and
 * the account panel says what it would show. A wallet only saves the reader from typing.
 */
export function PageHeader() {
  const { open } = useAppKit();
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();

  return (
    <header className="flex h-12 items-center justify-between gap-2 px-4">
      <span className="font-medium text-[13px] tracking-tight">Helico</span>
      {isConnected && address ? (
        <Button
          className="font-mono text-xs"
          onClick={() => disconnect()}
          size="sm"
          variant="ghost"
        >
          {short(address)}
        </Button>
      ) : (
        <Button onClick={() => open()} size="sm" variant="ghost">
          Connect wallet
        </Button>
      )}
    </header>
  );
}
