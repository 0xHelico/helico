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

/**
 * Where the app reads the chain from.
 *
 * **A default in code rather than a variable a deployment can forget.** Leaving the transport
 * unset does not fall back to the endpoint Arbitrum declares; it falls back to whatever the wallet
 * adapter prefers, and that is Reown's own RPC, which refuses a browser request from this origin:
 *
 * ```
 * FAILED https://rpc.walletconnect.org/v1/?chainId=eip155%3A42161&projectId=…
 * Access to fetch … from origin 'https://app.helico.site' blocked by CORS policy
 * ```
 *
 * Every read on the deployed dapp failed that way, which the portfolio rendered as "the chain did
 * not answer" and the chart rendered as nothing at all. One unset variable should not cost a page
 * its data, and `NEXT_PUBLIC_*` is baked at build time so the failure only appears once the image
 * is already live.
 *
 * The same reasoning as the factory address and the subgraph URL: a public endpoint is not a
 * secret, so it belongs in the repository and a clone works without being configured. Set the
 * variable to override it — with a paid endpoint, which this one rate-limits under real traffic,
 * or with a fork to test against real pool state. `next.config.ts` adds whatever is set to the
 * content policy beside this one.
 */
const rpcUrl =
  process.env.NEXT_PUBLIC_ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc";

export const wagmiAdapter = new WagmiAdapter({
  storage: createStorage({ storage: cookieStorage }),
  ssr: true,
  projectId,
  networks: [arbitrum],
  transports: { [arbitrum.id]: http(rpcUrl) },
});

export const config = wagmiAdapter.wagmiConfig;

/** What the chain is actually read from, exported so a test can hold the build to it. */
export const arbitrumRpcUrl = rpcUrl;
