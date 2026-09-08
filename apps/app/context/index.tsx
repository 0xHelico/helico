"use client";

import { arbitrum } from "@reown/appkit/networks";
import { createAppKit } from "@reown/appkit/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { type Config, cookieToInitialState, WagmiProvider } from "wagmi";
import { projectId, wagmiAdapter } from "@/config";

/**
 * A minute of staleness, and no refetch when a tab comes back.
 *
 * Every read here is a chain call or a subgraph query, both metered and neither changing by the
 * second. The default of "stale immediately" turned a click between two pages into a fresh round
 * of both, which is what made a rate limit reachable at all from a handful of visitors.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 60_000, refetchOnWindowFocus: false },
  },
});

/** Where this copy of the app is actually being served from. */
const origin =
  typeof window === "undefined"
    ? "https://app.helico.site"
    : window.location.origin;

createAppKit({
  adapters: [wagmiAdapter],
  projectId,
  networks: [arbitrum],
  defaultNetwork: arbitrum,
  metadata: {
    name: "Helico",
    description:
      "Your funds keep earning while prices move, under rules you set once.",
    // WalletConnect warns when this does not match the page it is running on, and on a local
    // run it never would. The deployed origin is the fallback, not the answer.
    url: origin,
    icons: [`${origin}/brand/mark.webp`],
  },
  features: { analytics: false, email: false, socials: false },
});

export function AppKitProvider({
  children,
  cookies,
}: {
  children: ReactNode;
  cookies: string | null;
}) {
  const initialState = cookieToInitialState(
    wagmiAdapter.wagmiConfig as Config,
    cookies,
  );

  return (
    <WagmiProvider
      config={wagmiAdapter.wagmiConfig as Config}
      initialState={initialState}
    >
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
