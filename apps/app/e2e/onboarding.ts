import type { Page } from "playwright";

/**
 * Get past the first-run dialog, the way a person would.
 *
 * Shared because two suites sign in and both would otherwise sit behind it, and because the one
 * thing worth keeping identical between them is the answer given: **the unlock switch goes off**.
 * Left on, every signed-in check would try to nominate an agent and permit four markets on a fork,
 * which is a different test than the one being written and would fail for reasons of its own.
 *
 * Returns whether the dialog was there. A wallet that has been through it already will not see it,
 * and a caller that treated absence as a failure would break on the second visit.
 */
export async function passOnboarding(page: Page): Promise<boolean> {
  const agree = page.getByRole("checkbox", { name: /read this and I agree/i });
  // Waited for, not counted. The dialog appears after the session read comes back, so a caller
  // that signs in and calls this on the next line finds nothing, returns false, and leaves the
  // terms sitting over the page it is about to assert on. That failure looks like the app being
  // broken rather than like a race, which is how it cost an afternoon.
  try {
    await agree.waitFor({ state: "visible", timeout: 20_000 });
  } catch {
    return false;
  }
  await agree.check();
  const unlock = page.getByRole("switch", { name: /turn everything on/i });
  if (await unlock.isChecked()) await unlock.click();
  await page.getByRole("button", { name: /^Start$/ }).click();
  await agree.waitFor({ state: "hidden", timeout: 15_000 });
  return true;
}
