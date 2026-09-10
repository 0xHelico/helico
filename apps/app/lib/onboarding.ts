"use client";

/**
 * Who has been through the first run, and what they chose.
 *
 * **Per wallet, not per browser.** The agreement below is that address's: a second wallet in the
 * same browser has agreed to nothing, and showing it the app as though it had would be recording
 * a consent nobody gave. It costs one key per address and answers the only question that matters
 * — "has *this* owner seen the terms" — which a single browser-wide flag cannot.
 *
 * `localStorage` and not the backend, deliberately. The backend has a session keyed to a wallet
 * and could hold this, but then a first run would need a round trip before the app could render,
 * and a backend that is down would put every returning user back through the terms. Nothing here
 * is a permission: the permissions are on chain, and this decides which screen is shown.
 */

export type Onboarding = {
  /** ISO 8601, so the record says when the terms were agreed rather than merely that they were. */
  agreedAt: string;
  /** Whether they asked for everything to be opened at once. */
  unlockAll: boolean;
  /** The version of the terms agreed to. Bumping it puts everyone through the dialog again. */
  terms: number;
};

/** Bump when the terms below change in a way somebody should read again. */
export const TERMS_VERSION = 1;

const key = (address: string) => `helico.onboarding.${address.toLowerCase()}`;

/**
 * What this wallet has agreed to, or null.
 *
 * Every read is wrapped: a private window, cleared site data, or a browser set to block storage
 * throws on access rather than returning empty, and a first-run dialog is not worth a blank page.
 * Failing to read means "has not been through it", which shows the dialog again — the safe
 * direction, since the alternative is skipping terms nobody has seen.
 */
export function readOnboarding(address: string | undefined): Onboarding | null {
  if (!address) return null;
  try {
    const raw = localStorage.getItem(key(address));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Onboarding;
    if (parsed.terms !== TERMS_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeOnboarding(address: string, unlockAll: boolean): void {
  try {
    localStorage.setItem(
      key(address),
      JSON.stringify({
        agreedAt: new Date().toISOString(),
        unlockAll,
        terms: TERMS_VERSION,
      } satisfies Onboarding),
    );
  } catch {
    // A browser that will not store it shows the dialog again next time, which is worse than
    // remembering and better than a crash on the first screen anyone sees.
  }
}
