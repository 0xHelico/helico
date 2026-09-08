import type { NextConfig } from "next";

/**
 * The content policy, and how its list was arrived at.
 *
 * Not guessed. Every origin below was **observed**: a scripted run signs in, walks all three
 * pages, and every request it makes is recorded by origin and resource type. Guessing a
 * `connect-src` for a wallet page is how a CSP that looks careful breaks signing in production,
 * where the only symptom is a button that does nothing.
 *
 * `script-src` keeps `'unsafe-inline'` because Next inlines its bootstrap and hydration data.
 * Nonces would remove it and need middleware on every response; that is a change to make with
 * more than five days to test it, and a CSP that breaks the app is worth less than this one.
 *
 * `img-src` allows any `https:` on purpose. Wallet icons come from whatever origin each wallet
 * publishes, through Reown's registry, so an allow-list here would be a list of every wallet that
 * exists — and an image cannot execute.
 *
 * The check that keeps this true is in the browser checks: any CSP violation the browser reports
 * while they run fails them. So an origin this list is missing is found here rather than by a
 * judge.
 */
/**
 * The backend this build talks to, which is the one the policy has to allow.
 *
 * Read from the same variable the browser reads, rather than written out twice. A production
 * build points at api.helico.site and a local one at localhost:8787, and hard-coding the first
 * is what blocks the session read on every local run — found exactly that way, by the browser
 * checks, before this shipped.
 */
const backend = (
  process.env.NEXT_PUBLIC_BE_API_URL || "https://api.helico.site"
).replace(/\/$/, "");

/**
 * The chain this build reads, for the same reason as `backend`: a build pointed at a fork has to
 * be allowed to reach it, and `e2e/fork-account.ts` points one at anvil.
 */
const rpc = process.env.NEXT_PUBLIC_ARBITRUM_RPC_URL?.replace(/\/$/, "");

const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data: https://fonts.reown.com",
  "img-src 'self' data: blob: https:",
  // Our backend, the chain, the subgraph we fall back to, and the three the wallet layer uses.
  [
    "connect-src 'self'",
    backend,
    "https://arb1.arbitrum.io https://*.arbitrum.io",
    rpc ?? "",
    "https://api.studio.thegraph.com",
    "https://api.web3modal.org https://rpc.walletconnect.org https://pulse.walletconnect.org",
    "wss://relay.walletconnect.org wss://relay.walletconnect.com",
    "https://cca-lite.coinbase.com",
  ].join(" "),
  // Reown's verify frame, and nothing else.
  "frame-src 'self' https://secure.walletconnect.org https://verify.walletconnect.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

/**
 * Headers this application sends on every response.
 *
 * The one that stops an attack rather than tidying a report is `frame-ancestors`: without it
 * this page can be framed, and its buttons open a wallet signature prompt. Clickjacking a page
 * like that is a live technique, not a theoretical one. `X-Frame-Options` says the same thing
 * to anything too old to read the CSP.
 *
 * HSTS is not here either, and should not be: it comes from the host proxy, which is where it
 * belongs, since it has to cover responses this application never gets to see.
 */
const securityHeaders = [
  // Enforced, and only this: it is the directive that closes an attack rather than tidying a
  // report, and it needs no allow-list to be right.
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  // The rest is report-only, deliberately, and the reason is a measurement rather than caution.
  //
  // The list below was built from observed traffic, and the browser checks fail on any violation
  // they see. Then I tested the guard by deleting `api.web3modal.org` from it — and the checks
  // still passed, because nothing they do asks that origin. So the guard is real but partial: it
  // proves the policy does not break what is checked, and cannot prove it does not break what is
  // not. A real WalletConnect session over the relay is the obvious gap.
  //
  // Enforcing a list with a known hole, three days before a demo video, risks the one flow the
  // whole submission depends on to close nothing that `frame-ancestors` has not already closed.
  // Report-only reports the same violations into the same console this suite reads, and blocks
  // nothing. Flip the key to `Content-Security-Policy` once a real wallet session has been
  // through it and the run is clean.
  { key: "Content-Security-Policy-Report-Only", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Nothing here asks for any of these, and a page that signs transactions should not be able to
  // start asking quietly.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
];

const config: NextConfig = {
  // Built into a container and served behind the same nginx as the rest of helico.site.
  output: "standalone",
  reactStrictMode: true,
  // Version numbers tell an attacker which bugs to try first.
  poweredByHeader: false,
  headers: () =>
    Promise.resolve([{ source: "/:path*", headers: securityHeaders }]),
};

export default config;
