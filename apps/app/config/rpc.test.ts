import { expect, test } from "bun:test";

import { arbitrumRpcUrl, config, networks } from "@/config/index";

// **The bug this exists for.** Leaving the transport unset does not fall back to the endpoint
// Arbitrum declares; it falls back to the wallet adapter's own RPC, which refuses a browser
// request from this app's origin. Every chain read on the deployed dapp failed that way, and
// because `NEXT_PUBLIC_*` is baked at build time the failure only showed once the image was live.
test("the chain is read from an endpoint that answers, with nothing configured", () => {
  expect(arbitrumRpcUrl).toBe("https://arb1.arbitrum.io/rpc");
  // Not Reown's, which is what an unset transport resolves to.
  expect(arbitrumRpcUrl).not.toContain("walletconnect");
});

// The variable still overrides, because that is how this app is pointed at a fork with real pool
// state, and how a paid endpoint replaces one that rate-limits under real traffic.
test("and the default is a default, not a hard-coding", async () => {
  const source = await Bun.file("config/index.tsx").text();
  expect(source).toContain("process.env.NEXT_PUBLIC_ARBITRUM_RPC_URL");
  // `||` and not `??`: an empty value in a deployment means "I did not set this", and treating
  // it as a URL is how `http("")` posts chain reads at the app's own origin.
  expect(source).toContain(
    'NEXT_PUBLIC_ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc"',
  );
});

// One network, and it is the one everything is deployed on. A transport keyed to a chain the
// config does not carry would be a transport nothing uses.
test("the transport is keyed to the only chain this product has", () => {
  expect(networks.map((n) => n.id)).toEqual([42161]);
  expect(Object.keys(config.chains.map((c) => c.id))).toHaveLength(1);
  expect(config.chains[0]?.id).toBe(42161);
});
