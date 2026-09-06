import { arbitrum } from "@reown/appkit/networks";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { cookieStorage, createStorage, http } from "@wagmi/core";

// The project id names a Reown project and grants nothing on its own, so it ships with the
// bundle the way a measurement id does. It has to be public: the browser sends it.
export const projectId =
  process.env.NEXT_PUBLIC_PROJECT_ID ?? "8cc38dcdd178b28a332ffb9750248a9d";

// One network. Helico's vault, the pool and the position all live on Arbitrum One, and offering
// a chain the product cannot act on would be a way to waste somebody's gas.
export const networks = [arbitrum] as const;

// Where the app reads the chain from. Unset falls back to the public endpoint the chain
// declares, which is fine to develop against and rate-limits under any real traffic. It is
// also how the app is pointed at a fork to be tested against real pool state.
const rpcUrl = process.env.NEXT_PUBLIC_ARBITRUM_RPC_URL;

export const wagmiAdapter = new WagmiAdapter({
  storage: createStorage({ storage: cookieStorage }),
  ssr: true,
  projectId,
  networks: [arbitrum],
  transports: rpcUrl ? { [arbitrum.id]: http(rpcUrl) } : undefined,
});

export const config = wagmiAdapter.wagmiConfig;
