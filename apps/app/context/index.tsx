'use client'

import { createAppKit } from '@reown/appkit/react'
import { arbitrum } from '@reown/appkit/networks'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { type Config, cookieToInitialState, WagmiProvider } from 'wagmi'
import { networks, projectId, wagmiAdapter } from '@/config'

const queryClient = new QueryClient()

createAppKit({
  adapters: [wagmiAdapter],
  projectId,
  networks,
  defaultNetwork: arbitrum,
  metadata: {
    name: 'Helico',
    description: 'Your funds keep earning while prices move, under rules you set once.',
    url: 'https://app.helico.site',
    icons: ['https://app.helico.site/brand/mark.webp'],
  },
  features: { analytics: false, email: false, socials: false },
})

export function AppKitProvider({
  children,
  cookies,
}: {
  children: ReactNode
  cookies: string | null
}) {
  const initialState = cookieToInitialState(wagmiAdapter.wagmiConfig as Config, cookies)

  return (
    <WagmiProvider config={wagmiAdapter.wagmiConfig as Config} initialState={initialState}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  )
}
