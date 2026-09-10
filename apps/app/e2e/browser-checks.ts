/**
 * The behaviours that only a browser can show, and that each cost a real bug.
 *
 *   anvil --fork-url https://arb1.arbitrum.io/rpc --port 8545 --silent &
 *   apps/be running, then:  bun run build && bun run start -p 3100
 *   bun run e2e
 *
 * A wallet is injected as an EIP-6963 provider signing with a throwaway key, so the whole
 * connect → verify → use path runs without a human.
 */
import { chromium, type Page } from "playwright";
import { toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { passOnboarding } from "./onboarding";

const APP = process.env.APP_URL ?? "http://localhost:3100";

// The front door is the conversation now, and it holds a connection open, so "networkidle" is a
// condition that may never arrive there. Every visit to it waits for the document and then for
// something on the page — which is what the checks were really waiting for anyway.
const FORK = process.env.FORK_RPC_URL ?? "http://127.0.0.1:8545";

const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  console.log(
    `${ok ? "  ok  " : "FAIL  "}${name}${detail ? `  — ${detail}` : ""}`,
  );
  if (!ok) {
    failures.push(name);
  }
}

const wallet = (_key: `0x${string}`, address: string) => `
(() => {
  const provider = {
    isMetaMask: true, _events: {},
    on(){return this}, removeListener(){return this},
    async request({ method, params = [] }) {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [${JSON.stringify(address)}];
      if (method === 'eth_chainId') return ${JSON.stringify(toHex(arbitrum.id))};
      if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
      if (method === 'personal_sign') return window.__personalSign(params[0]);
      if (method === 'eth_signTypedData_v4' || method === 'eth_signTypedData')
        return window.__signTypedData(typeof params[1] === 'string' ? params[1] : JSON.stringify(params[1]));
      const res = await fetch(${JSON.stringify(FORK)}, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const body = await res.json();
      if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code });
      return body.result;
    },
  };
  window.ethereum = provider;
  const detail = Object.freeze({
    info: { uuid: '11111111-2222-3333-4444-555555555555', name: 'Test Wallet',
            icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=',
            rdns: 'site.helico.testwallet' },
    provider,
  });
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
})()`;

/**
 * What says a page is past the sign-in gate.
 *
 * It used to be "any textbox", which worked only because the front page happened to carry the
 * vault-address input. That form went with the vault it configured, and a check that depends on
 * an unrelated input is a check that fails for reasons it is not about — so this asks for the
 * page's own heading, which is the thing the gate is standing in front of.
 *
 * The heading moved when the conversation became the front door. It is the chat's own now, and
 * the limits page's heading lives at `/limit` where check 5 asks for it.
 */
const inTheApp = (page: Page) =>
  page.getByRole("heading", { name: /what would you like to do/i });

async function withWallet(page: Page) {
  watchCsp(page);
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  await page.exposeFunction("__personalSign", async (m: `0x${string}`) =>
    account.signMessage({ message: { raw: m } }),
  );
  await page.exposeFunction("__signTypedData", async (json: string) =>
    account.signTypedData(JSON.parse(json)),
  );
  await page.addInitScript(wallet(key, account.address));
  return account;
}

const browser = await chromium.launch();

/**
 * Any Content-Security-Policy the browser refuses to obey fails these checks.
 *
 * The policy is an allow-list of origins that were measured rather than guessed, and the way a
 * missing one shows up in production is a button that does nothing. Here it shows up as a
 * console message, which is the only cheap moment to find it.
 */
const cspViolations: string[] = [];
const watchCsp = (page: Page) => {
  page.on("console", (m) => {
    const text = m.text();
    if (
      /Content Security Policy|Refused to (load|connect|execute|apply)/i.test(
        text,
      )
    ) {
      cspViolations.push(text.slice(0, 160));
    }
  });
  return page;
};

// 1. No wallet means no request to the session endpoint. It used to ask on every cold load and
//    take a 401 for an answer it could not have used.
{
  const page = watchCsp(await (await browser.newContext()).newPage());
  const calls: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/session")) {
      calls.push(r.method());
    }
  });
  await page.goto(APP, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  check(
    "no wallet asks nothing of /api/session",
    calls.length === 0,
    calls.join(", "),
  );
  check(
    "and the gate is shown",
    await page.getByRole("button", { name: "Connect wallet" }).isVisible(),
  );
}

// 2. A session read that never answers must not blank the page. It used to render an empty div,
//    which on a dark theme is a black screen and was permanent while the request hung.
{
  const page = watchCsp(await (await browser.newContext()).newPage());
  await withWallet(page);
  await page.route("**/api/session*", () => {
    /* deliberately never fulfilled */
  });
  await page.goto(APP, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1600);
  const text = (await page.locator("body").innerText()).trim();
  check(
    "a hung session read still renders the gate",
    /Your wallet is the account/.test(text),
  );
  check(
    "and is not still spinning",
    (await page.locator(".animate-spin").count()) === 0,
  );
}

// 3. The other side of that: a signed-in wallet reloading must not see the gate flash past.
{
  const page = watchCsp(await (await browser.newContext()).newPage());
  await withWallet(page);
  await page.goto(APP, { waitUntil: "domcontentloaded" });
  await page
    .getByRole("button", { name: /Verify wallet/ })
    .click({ timeout: 20_000 });
  await passOnboarding(page);
  await inTheApp(page).waitFor({ timeout: 30_000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  let flashed = false;
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(80);
    if (await page.getByRole("button", { name: "Connect wallet" }).count()) {
      flashed = true;
    }
  }
  check("a reload does not flash the gate", !flashed);
  check("and lands back in the app", (await inTheApp(page).count()) > 0);
}

// 4. And the one that actually bit: the cookie must come back on a reload even when the browser
//    refuses third-party cookies. It was SameSite=None on the belief that app.helico.site and
//    api.helico.site were different sites — they are the same site — so it was a third-party
//    cookie, and signing in never stuck anywhere the page was not on helico.site.
{
  const strict = await chromium.launch({
    args: ["--block-third-party-cookies"],
  });
  const ctx = await strict.newContext();
  const page = watchCsp(await ctx.newPage());
  await withWallet(page);
  await page.goto(APP, { waitUntil: "domcontentloaded" });
  await page
    .getByRole("button", { name: /Verify wallet/ })
    .click({ timeout: 20_000 });
  await passOnboarding(page);
  await inTheApp(page).waitFor({ timeout: 30_000 });

  const jar = (await ctx.cookies()).filter((c) => c.name === "helico_session");
  check("the session cookie is stored", jar.length === 1);
  check(
    "and it is not third-party",
    jar[0]?.sameSite === "Lax",
    `SameSite=${jar[0]?.sameSite}`,
  );

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  check(
    "still signed in after a reload, third-party cookies blocked",
    (await inTheApp(page).count()) > 0,
  );
  await strict.close();
}

// 5. The front door is the conversation, and the limits are a page of their own at /limit.
//
//    This check used to assert the opposite, and most of it had stopped meaning anything long
//    before the doors were swapped: five of its six assertions named text — "What it may be
//    allowed to do", "What you can ask it", a `grants` test id, "Read the split" — that was
//    deleted when the front page was simplified, and nothing failed, because nothing had run it.
//    Rewritten against what the two pages actually render.
{
  const page = watchCsp(await (await browser.newContext()).newPage());
  await withWallet(page);
  await page.goto(APP, { waitUntil: "domcontentloaded" });
  await page
    .getByRole("button", { name: /Verify wallet/ })
    .click({ timeout: 20_000 });

  // The first run stands here, and it is the check as much as it is in the way.
  const agree = page.getByRole("checkbox", { name: /read this and I agree/i });
  await agree.waitFor({ timeout: 30_000 });
  const start = page.getByRole("button", { name: /^Start$/ });
  check("a new wallet is asked to agree first", await agree.isVisible());
  check("and cannot start until it has", await start.isDisabled());
  check(
    "unlock everything is offered, and defaults to on",
    await page.getByRole("switch", { name: /unlock everything/i }).isChecked(),
  );
  await passOnboarding(page);

  await inTheApp(page).waitFor({ timeout: 30_000 });
  const front = (await page.locator("body").innerText()).trim();
  check(
    "the front door is the conversation",
    /What would you like to do/.test(front),
  );
  check(
    "with the composer on it",
    (await page.getByPlaceholder(/Ask anything/i).count()) > 0,
  );
  check("and not the limits", !/limits it works inside/.test(front));

  // Asked again on a reload. Agreeing once has to be enough, or the terms become a toll.
  await page.reload({ waitUntil: "domcontentloaded" });
  await inTheApp(page).waitFor({ timeout: 30_000 });
  check(
    "and it is not asked again",
    (await page
      .getByRole("checkbox", { name: /read this and I agree/i })
      .count()) === 0,
  );

  await page.goto(`${APP}/limit`, { waitUntil: "domcontentloaded" });
  await page
    .getByRole("heading", { name: /limits it works inside/ })
    .waitFor({ timeout: 30_000 });
  const limits = (await page.locator("body").innerText()).trim();
  check(
    "the limits have a page of their own",
    /The limits you set/.test(limits),
  );
  check(
    "both of them are named",
    /Who may move it/.test(limits) && /Where it may go/.test(limits),
  );
  check(
    "the markets are listed",
    /Aave v3/.test(limits) && /Morpho/.test(limits),
  );
  check(
    "the portfolio is summarised, not repeated",
    /In your account/.test(limits),
  );
  check(
    "and it links to the page that has it",
    (await page.getByRole("link", { name: /View full portfolio/ }).count()) > 0,
  );
  // The factory is deployed, so this is a measurement rather than an absence: a total, read from
  // an account the chain can name before anyone opens it.
  check(
    "the summary totals an account rather than saying it cannot",
    /In your account/.test(limits) && !/deployed yet/.test(limits),
  );
  check(
    "the composer is not on it",
    (await page.getByPlaceholder(/Ask anything/i).count()) === 0,
  );

  // The old address still lands somewhere true rather than on a 404.
  await page.goto(`${APP}/chat`, { waitUntil: "domcontentloaded" });
  await inTheApp(page).waitFor({ timeout: 30_000 });
  check(
    "the old /chat address lands on the front door",
    new URL(page.url()).pathname === "/",
  );
}

// 6. The portfolio has its own page now, and the two panels that only an indexer can answer live
//    on it. Checked separately because a summary linking to a page nobody can load is worse than
//    no summary.
{
  const page = watchCsp(await (await browser.newContext()).newPage());
  await withWallet(page);
  await page.goto(`${APP}/portfolio`, { waitUntil: "networkidle" });
  await page
    .getByRole("button", { name: /Verify wallet/ })
    .click({ timeout: 20_000 });
  await page
    .getByRole("heading", { name: /Welcome|Portfolio/ })
    .waitFor({ timeout: 30_000 });
  // The account is read from the chain, so the page renders before it can answer. Waiting for
  // the answer rather than for the page is the difference between checking what it shows and
  // checking that it started.
  await page
    .getByText(/not opened yet|open$/)
    .first()
    .waitFor({ timeout: 30_000 });
  const text = (await page.locator("body").innerText()).trim();
  check("the portfolio page loads", /In your account/.test(text));
  check("your account is on it", /Your account/.test(text));
  // The claim the whole account design rests on, checked against the deployed factory: an
  // address for an account that does not exist yet, and the page saying which of the two it is.
  check(
    "with an address the factory names before the account exists",
    /not opened yet/.test(text) && /0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}/.test(text),
  );
  check(
    "and the mandates nobody can list",
    /What this wallet may spend/.test(text),
  );
  check(
    "which says why an indexer is the only way",
    /no on-chain way to ask this/.test(text),
  );
}

// 7. The subgraph panels must survive our own backend.
//
// Reading Studio directly is what made them work when everything of ours was down, and putting a
// cache in front would trade that away without a word. Every request to the cache is refused
// here; the page can only answer by asking Studio itself.
{
  const ctx = await browser.newContext();
  const page = watchCsp(await ctx.newPage());
  await withWallet(page);
  await page.goto(`${APP}/`, { waitUntil: "domcontentloaded" });
  const verify = page.getByRole("button", { name: /verify wallet/i });
  await verify.waitFor({ timeout: 30_000 });
  await verify.click();
  await page.waitForTimeout(3000);

  let refused = 0;
  let direct = 0;
  await page.route("**/api/graph", (route) => {
    refused++;
    return route.abort("connectionrefused");
  });
  await page.route("**/api.studio.thegraph.com/**", (route) => {
    direct++;
    return route.continue();
  });

  await page.goto(`${APP}/portfolio`, { waitUntil: "domcontentloaded" });
  await page
    .getByText(/not opened yet|open$/)
    .first()
    .waitFor({ timeout: 30_000 });
  await page.waitForTimeout(4000);
  const text = (await page.locator("body").innerText()).trim();

  check("the cache is asked first", refused > 0, `${refused} refused`);
  check(
    "and Studio answers when it is not there",
    direct > 0,
    `${direct} direct`,
  );
  check(
    "so the panel still renders with our backend unreachable",
    /What this wallet may spend/.test(text),
  );
}

check(
  "no Content-Security-Policy violation anywhere",
  cspViolations.length === 0,
  cspViolations[0] ?? `${cspViolations.length}`,
);

await browser.close();
if (failures.length) {
  console.error(`\n${failures.length} failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nall browser checks passed");
