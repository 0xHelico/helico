import type { NextConfig } from "next";

/**
 * Headers this application sends on every response.
 *
 * The one that stops an attack rather than tidying a report is `frame-ancestors`: without it
 * this page can be framed, and its buttons open a wallet signature prompt. Clickjacking a page
 * like that is a live technique, not a theoretical one. `X-Frame-Options` says the same thing
 * to anything too old to read the CSP.
 *
 * Deliberately absent: a full `Content-Security-Policy`. A wallet page pulls in Reown and
 * WalletConnect, which open WebSockets, load remote images and use their own frames, so a
 * script-src and connect-src tight enough to be worth having is a change that has to be tested
 * against a real wallet connection rather than guessed at. Filed rather than rushed — a CSP that
 * breaks signing is worse than no CSP.
 *
 * HSTS is not here either, and should not be: it comes from the host proxy, which is where it
 * belongs, since it has to cover responses this application never gets to see.
 */
const securityHeaders = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
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
