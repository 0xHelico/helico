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

// ── the doors, which a green deploy does not prove are there ──────────────────
//
// Both pages show the same gate to a visitor without a wallet, so the body cannot tell them
// apart. The title can: it comes from the route's own metadata, so "Limits" at /limit is the
// deployed build saying that route exists. Worth its own check because the failure it catches is
// silent — an image that built, pushed and started, from the commit before the routes moved.
{
  const title = async (path: string) => {
    const res = await fetch(`${APP}${path}`);
    return /<title>([^<]*)/.exec(await res.text())?.[1] ?? "";
  };
  const [front, limits, portfolio] = await Promise.all([
    title("/"),
    title("/limit"),
    title("/portfolio"),
  ]);
  check("the front door is the app itself", front === "Helico", front);
  check("the limits have their own route", limits === "Limits", limits);
  check(
    "and the portfolio still has its own",
    /Portfolio/.test(portfolio),
    portfolio,
  );

  // The two addresses that predate the swap. Neither may 404: one of them is in the backend's
  // own cards, and the other is written into the chat's greeting.
  for (const path of ["/chat", "/mandate"]) {
    const res = await fetch(`${APP}${path}`, { redirect: "manual" });
    check(`${path} still lands somewhere`, res.status < 400, `${res.status}`);
  }
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

// ── and what the API sends, which is the origin the session cookie lives on ───
{
  const { headers: h } = await headers(`${API}/healthz`);
  // The one that is a real problem rather than hygiene: several routes put caller-supplied text
  // into a JSON body, and a response sniffed into a document runs on the origin holding the
  // session cookie.
  check(
    "the API refuses to be sniffed",
    h.get("x-content-type-options") === "nosniff",
    h.get("x-content-type-options") ?? "missing",
  );
  check(
    "and says it is not a document",
    (h.get("content-security-policy") ?? "").includes("default-src 'none'"),
    h.get("content-security-policy") ?? "(none)",
  );
  check(
    "and sends no referrer",
    h.get("referrer-policy") === "no-referrer",
    h.get("referrer-policy") ?? "missing",
  );
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

  // The chat, which nothing here watched until #314 — and the one thing a judge types first.
  //
  // One model call. The message names no token and no amount, which is the shape that reached the
  // swap path until #305 and came back demanding three fields nobody had mentioned. Both halves of
  // the fix are asserted: what it was read as, and that the answer carries the cards the app draws
  // instead of the paragraph they replaced.
  const asked = await fetch(`${API}/api/swap/intent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "p" }),
  });
  const answer2 = (await asked.json()) as {
    action?: string;
    cards?: { title?: string; try?: string; href?: string }[];
  };
  check(
    "a message naming nothing is answered, not interrogated",
    asked.ok && answer2.action === "about",
    `${asked.status} · ${answer2.action ?? "(none)"}`,
  );
  const cards = answer2.cards ?? [];
  check(
    "and the answer comes back as cards",
    cards.length > 0,
    cards.map((c) => c.title).join(", ") || "(none)",
  );
  // Pressable or it is a bordered bullet. The app renders a card with neither as plain text, so
  // one that arrives with neither is a card nobody can use.
  check(
    "every card offers a sentence to send or a screen to open",
    cards.length > 0 && cards.every((c) => Boolean(c.try) !== Boolean(c.href)),
  );

  // Every starter on the front door, sent to the model that will actually receive it.
  //
  // These are the six buttons a person meets before they have typed anything, and each one claims
  // in `lib/constants.ts` which of the five actions it lands on. A starter that lands somewhere
  // else is a button that answers a question nobody asked, and rewording one is exactly how that
  // happens quietly. Six model calls, on a suite that is run by hand before a recording.
  const starters: [string, string][] = [
    ["What can you do?", "about"],
    ["Check my portfolio", "status"],
    // The one that would have caught #390. `earn` is the newest action, so a backend deploy that
    // silently did not happen answers this with `about` and fails here by name — which is more
    // than the cancelled workflow run managed to say.
    ["Put my idle USDC to work", "earn"],
    ["Move money into my account", "deposit"],
    ["Swap 0.1 ETH into USDC", "swap"],
    ["Why has nothing moved?", "status"],
    ["Stop the agent", "revoke"],
    ["Take everything back to my wallet", "withdraw"],
  ];
  // One at a time, and backing off when told to. The endpoint allows six messages a minute per
  // address (`BE_SWAP_RATE_PER_MIN`), and this suite has already spent one on "p" above, so
  // sending six more in a row earns a 429 on the last of them. The first version of this check
  // read that as a missing action and blamed the wording of three starters that answer correctly.
  //
  // Worth knowing beyond this file: there are six starters on the front door and six messages a
  // minute, so a person who presses every one of them and then types is at the limit.
  const landed: { message: string; want: string; got: string }[] = [];
  const ask = async (message: string) => {
    const res = await fetch(`${API}/api/swap/intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    return res;
  };
  for (const [message, want] of starters) {
    let res = await ask(message);
    if (res.status === 429) {
      const after = Number(res.headers.get("retry-after") ?? "10");
      await new Promise((r) => setTimeout(r, (after + 1) * 1000));
      res = await ask(message);
    }
    const got = res.ok
      ? (((await res.json()) as { action?: string }).action ?? "(none)")
      : `HTTP ${res.status}`;
    landed.push({ message, want, got });
  }
  const wrong = landed.filter((l) => l.got !== l.want);
  check(
    "every starter on the front door lands where it says it does",
    wrong.length === 0,
    wrong.length === 0
      ? landed.map((l) => l.got).join(", ")
      : wrong.map((l) => `"${l.message}" → ${l.got}, not ${l.want}`).join("; "),
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

// ── Behind the gate, only when asked ──────────────────────────────────────────
//
// Everything above is what an anonymous visitor sees, which stops at the sign-in gate — so the
// account panel, and with it whether the deployed build resolves a factory at all, was never
// checked. That gap matters: `NEXT_PUBLIC_ACCOUNT_FACTORY` set to an **empty string** is a
// documented way to render the not-deployed path, and `?? DEPLOYED` does not catch it, so one
// blank value in the deployment turns the panel off and every check above still passes.
//
// Opt-in because it signs in, which writes a session row exactly as any visitor does.
//
//     PROBE_WALLET=1 bun run --filter @helico/app prod
if (process.env.PROBE_WALLET) {
  const { privateKeyToAccount, generatePrivateKey } = await import(
    "viem/accounts"
  );
  const { toHex } = await import("viem");
  const { arbitrum } = await import("viem/chains");
  const owner = privateKeyToAccount(generatePrivateKey());
  const page = await ctx.newPage();
  await page.exposeFunction("__personalSign", async (m: `0x${string}`) =>
    owner.signMessage({ message: { raw: m } }),
  );
  await page.exposeFunction("__signTypedData", async (j: string) =>
    owner.signTypedData(JSON.parse(j)),
  );
  await page.addInitScript(`
(() => {
  const provider = { isMetaMask: true, on(){return this}, removeListener(){return this},
    async request({ method, params = [] }) {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [${JSON.stringify(owner.address)}];
      if (method === 'eth_chainId') return ${JSON.stringify(toHex(arbitrum.id))};
      if (method === 'wallet_switchEthereumChain') return null;
      if (method === 'personal_sign') return window.__personalSign(params[0]);
      if (method === 'eth_signTypedData_v4' || method === 'eth_signTypedData')
        return window.__signTypedData(typeof params[1] === 'string' ? params[1] : JSON.stringify(params[1]));
      throw new Error('read-only: ' + method);
    } };
  window.ethereum = provider;
  const detail = Object.freeze({ info: { uuid: '11111111-2222-3333-4444-555555555555', name: 'Probe',
    icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=',
    rdns: 'site.helico.probe' }, provider });
  const a = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  window.addEventListener('eip6963:requestProvider', a); a();
})()`);
  await page.goto(`${APP}/`, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  await page
    .getByRole("button", { name: /verify wallet/i })
    .click({ timeout: 30_000 });
  await page.waitForTimeout(4000);
  await page.goto(`${APP}/portfolio`, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  await page.waitForTimeout(9000);
  const behind = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  check(
    "signing in works against the deployed backend",
    /Your account/i.test(behind),
  );
  check(
    "and the deployed build resolves a factory",
    !/No account factory is deployed/i.test(behind),
  );
  // A CREATE2 address for a wallet that has never transacted: only a real `accountFor` produces
  // one, so this is the factory answering rather than a default rendering.
  check(
    "which names an account before it exists",
    /0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4} · not opened yet/.test(behind),
    behind.match(/0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4} · not opened yet/)?.[0] ?? "",
  );
}

check("no page threw anywhere", errors.length === 0, errors[0] ?? "");

await browser.close();
if (failures.length) {
  console.error(`\n${failures.length} failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nwhat is deployed answers, and says what it should");
