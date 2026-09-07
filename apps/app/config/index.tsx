import { arbitrum } from "@reown/appkit/networks";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { cookieStorage, createStorage } from "@wagmi/core";

// The project id names a Reown project and grants nothing on its own, so it ships with the
// bundle the way a measurement id does. It has to be public: the browser sends it.
export const projectId =
  process.env.NEXT_PUBLIC_PROJECT_ID ?? "8cc38dcdd178b28a332ffb9750248a9d";

// One network. Helico's vault, the pool and the position all live on Arbitrum One, and offering
// a chain the product cannot act on would be a way to waste somebody's gas.
export const networks = [arbitrum] as const;

export const wagmiAdapter = new WagmiAdapter({
  storage: createStorage({ storage: cookieStorage }),
  ssr: true,
  projectId,
  networks: [arbitrum],
});

export const config = wagmiAdapter.wagmiConfig;
