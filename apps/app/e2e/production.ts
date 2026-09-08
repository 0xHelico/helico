/**
 * The deployed thing, checked the way a judge meets it.
 *
 * Thirty-two browser checks run against a local build, and none of them had ever looked at what
 * is actually served. A 200 is not evidence a page works — the same rule this project applies to
 * a transaction hash — and the gap between "CI is green" and "the site a judge opens" is exactly
 * where a bad deploy hides.
 *
 * Read-only: no wallet, no writes, nothing signed. Safe to run at any time, and worth running
 * before recording anything.
 *
 *   bun run --filter @helico/app prod
 */
import { chromium, type Page } from "playwright";

const LANDING = process.env.LANDING_URL ?? "https://helico.site";
const APP = process.env.APP_ORIGIN ?? "https://app.helico.site";
const API = process.env.API_ORIGIN ?? "https://api.helico.site";

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  console.log(
    `${ok ? "  ok  " : "FAIL  "}${name}${detail ? `  — ${detail}` : ""}`,
  );
  if (!ok) failures.push(name);
};

const headers = async (url: string) => {
  const res = await fetch(url, { redirect: "manual" });
  const out = new Map<string, string>();
  // A braced body: `out.set` returns the Map, and an arrow returning it from forEach is what
  // `useIterableCallbackReturn` refuses.
  res.headers.forEach((v, k) => {
    out.set(k.toLowerCase(), v);
  });
  return { status: res.status, headers: out };
};

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 900 },
});

const errors: string[] = [];
const open = async (url: string): Promise<{ page: Page; text: string }> => {
  const page = await ctx.newPage();
  page.on("pageerror", (e) =>
    errors.push(`${url}: ${String(e).slice(0, 100)}`),
  );
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(5000);
  return {
    page,
    text: (await page.locator("body").innerText()).replace(/\s+/g, " ").trim(),
  };
};

// ── the landing, which is where a judge starts ────────────────────────────────
{
  const { page, text } = await open(`${LANDING}/`);
  check("the landing renders", text.length > 2000, `${text.length} chars`);
  check("and leads with the product", /Your Funds, on Autopilot/i.test(text));
  // The section that says what stops the agent. It said "not deployed yet" until today.
  check(
    "the rules panel says the contracts are deployed",
    /Arbitrum One · deployed/i.test(text),
  );
  check("and does not still claim otherwise", !/not deployed yet/i.test(text));
  // The grid is images, so the names are in `alt` and not in the page's text. Reading `text`
  // here passed the "Uniswap is gone" assertion for the wrong reason — it was gone from a place
  // it had never been.
  const brands = await page
    .locator(".brands__grid img")
    .evaluateAll((els) => els.map((e) => (e as HTMLImageElement).alt));
  check(
    "1inch is in the brand grid",
    brands.some((a) => /1inch/i.test(a)),
    brands.join(", "),
  );
  check("and Uniswap is not", !brands.some((a) => /uniswap/i.test(a)));
}

// ── the blog, built from the backend or the files ─────────────────────────────
{
  const { text } = await open(`${LANDING}/blog/`);
  check(
    "the blog lists posts",
    /Notes from building Helico/i.test(text) && text.length > 600,
  );
}

// ── the dapp, as an unauthenticated visitor meets it ──────────────────────────
{
  const { text } = await open(`${APP}/`);
  check("the dapp renders its gate", /Your wallet is the account/i.test(text));
  check("and offers to connect", /Connect your wallet/i.test(text));
}

// ── what the dapp sends, which is the half a browser does not show ────────────
{
  const { headers: h } = await headers(`${APP}/`);
  check(
    "framing is refused, and enforced",
    (h.get("content-security-policy") ?? "").includes("frame-ancestors 'none'"),
    h.get("content-security-policy") ?? "(none)",
  );
  check(
    "the fuller policy is reported",
    Boolean(h.get("content-security-policy-report-only")),
  );
  for (const key of [
    "x-frame-options",
    "x-content-type-options",
    "referrer-policy",
    "strict-transport-security",
  ]) {
    check(`it sends ${key}`, Boolean(h.get(key)), h.get(key) ?? "missing");
  }
}

// ── the backend, including the cache the dapp falls back from ─────────────────
{
  const health = await fetch(`${API}/healthz`).then(
    (r) => r.json() as Promise<{ status?: string }>,
  );
  check("the backend is up", health.status === "ok");

  // Same body the browser sends. Cached, so this is one upstream query at most.
  const body = JSON.stringify({
    query:
      "\n  query Movements($maker: Bytes!, $first: Int!) {\n    movements(where: { mandate_: { maker: $maker } } orderBy: timestamp orderDirection: asc first: $first) {\n      timestamp\n    }\n  }\n",
    variables: {
      maker: "0xcdbde4f92af8be2117afae94f4ef3f5d3b3b39d8",
      first: 1000,
    },
  });
  const graph = await fetch(`${API}/api/graph`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const answer = (await graph.json()) as { data?: { movements?: unknown[] } };
  check(
    "the subgraph cache answers",
    graph.ok && Array.isArray(answer.data?.movements),
  );
  check(
    "and says whether it served or fetched",
    ["hit", "miss"].includes(graph.headers.get("x-cache") ?? ""),
    graph.headers.get("x-cache") ?? "(none)",
  );

  // The allow-list is what stops it being an open proxy onto our own quota.
  const refused = await fetch(`${API}/api/graph`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "query Everything { mandates { id } }" }),
  });
  check(
    "and refuses an operation it does not serve",
    refused.status === 403,
    `${refused.status}`,
  );
}

check("no page threw anywhere", errors.length === 0, errors[0] ?? "");

await browser.close();
if (failures.length) {
  console.error(`\n${failures.length} failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nwhat is deployed answers, and says what it should");
