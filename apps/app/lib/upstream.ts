/**
 * The headers this app's server routes send when they call `apps/be` on a visitor's behalf.
 *
 * **Why the caller's address has to travel.** `/api/chat` proxies to `POST /api/swap/intent`
 * from the server, so without this the backend's rate limiter sees one client — this container —
 * for every visitor at once. Its budget is 6 calls a minute and 500 a day, and that budget is
 * against a paid model, so one bucket shared by everybody means two people demoing at the same
 * time rate-limit each other, and one abusive caller switches the feature off for all of them.
 *
 * **Why `X-Real-IP` and not `X-Forwarded-For`.** The backend reads `X-Real-IP` and deliberately
 * ignores `X-Forwarded-For`, because an appending proxy leaves the first entry of that header in
 * the caller's hands and a forged single-entry one is indistinguishable from a real one. See
 * `apps/be/internal/httpapi/limit.go`.
 *
 * **What this trusts.** Exactly one thing: that the proxy in front of this app overwrites
 * `X-Real-IP` with the socket address rather than passing through what a caller sent. nginx's
 * `proxy_set_header X-Real-IP $remote_addr` does. If that ever stops being true, a caller can
 * choose their own rate-limit bucket — which is why the header is forwarded only when it is
 * present, and never synthesised here.
 *
 * **Today the header does not survive the trip, and that is the safety margin.** `BE_API_URL`
 * points at the public `https://api.helico.site`, so this request leaves the network and arrives
 * at the API's own nginx block as an ordinary client — and that block sets `X-Real-IP` from
 * `$remote_addr`, overwriting whatever was forwarded. So this change cannot currently be abused,
 * and cannot currently help either.
 *
 * **It becomes load-bearing the moment `BE_API_URL` points at the api container directly.** Over
 * the shared network there is no second nginx to overwrite anything, and the header this function
 * forwards is the one the backend trusts. Two things must hold before that move:
 *
 *   1. `app.helico.site`'s inbound block sets `X-Real-IP` from `$remote_addr` rather than passing
 *      through a caller's. The *inbound* block is the guarantee — not the one in front of the API.
 *   2. Nothing can reach the backend without passing an nginx at all. Publishing it on `0.0.0.0`
 *      (see #103) would route around both blocks, and that is the change that turns this from
 *      inert into a hole.
 */
export function upstreamHeaders(incoming: Headers): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // Absent in local development, and absent if the proxy is ever reconfigured. Sending nothing
  // leaves the backend on its socket fallback, which is exactly today's behaviour — this can
  // improve the limiter's accuracy, never make it worse.
  const caller = incoming.get("x-real-ip")?.trim();
  if (caller) {
    headers["X-Real-IP"] = caller;
  }

  return headers;
}
