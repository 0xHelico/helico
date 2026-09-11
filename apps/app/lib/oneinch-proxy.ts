/**
 * What our 1inch proxy will forward, and how often.
 *
 * Kept out of the route handler so it can be tested without a server. The route is the only place
 * the key is read; this is the only place the rules are written.
 */

/**
 * The six shapes, matched whole.
 *
 * **An allowlist rather than a pass-through**, because a proxy that forwards any path is a way for
 * anybody to spend our quota on anything 1inch sells, with our key and without our knowledge.
 * Anything else is answered 404 by us — not forwarded and then refused by them, which would still
 * have cost a request.
 *
 * The token lists are matched as addresses rather than as "anything", so a path cannot smuggle a
 * traversal through the segment that looks like data.
 */
export const ALLOWED: RegExp[] = [
  /^swap\/v6\.1\/\d+\/quote$/,
  /^swap\/v6\.1\/\d+\/swap$/,
  /^swap\/v6\.1\/\d+\/approve\/spender$/,
  /^swap\/v6\.1\/\d+\/approve\/transaction$/,
  /^price\/v1\.1\/\d+\/0x[0-9a-fA-F]{40}(,0x[0-9a-fA-F]{40})*$/,
  /^balance\/v1\.2\/\d+\/balances\/0x[0-9a-fA-F]{40}$/,
];

export const forwards = (path: string): boolean =>
  ALLOWED.some((allowed) => allowed.test(path));

/**
 * Requests per minute per caller. The Go backend allows six swaps a minute; a card makes several
 * reads per swap, so this is the same order of generosity rather than the same number.
 */
export const PER_MINUTE = 30;

const seen = new Map<string, { count: number; resetAt: number }>();

/**
 * Whether this caller has had enough for now.
 *
 * The ceiling is honest: in memory and per instance, so it resets on deploy and would not hold
 * across several. One VM runs this, which is the case it is written for.
 */
export function overLimit(who: string, now = Date.now()): boolean {
  const bucket = seen.get(who);
  if (!bucket || now > bucket.resetAt) {
    seen.set(who, { count: 1, resetAt: now + 60_000 });
    // Swept on a request rather than on a timer: the map only grows while requests arrive, and a
    // request is exactly when there is someone to pay for the sweep.
    if (seen.size > 5_000) {
      for (const [key, b] of seen) if (now > b.resetAt) seen.delete(key);
    }
    return false;
  }
  bucket.count += 1;
  return bucket.count > PER_MINUTE;
}
