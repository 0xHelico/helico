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

const APP = process.env.APP_URL ?? "http://localhost:3100";
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

const wallet = (key: `0x${string}`, address: string) => `
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

async function withWallet(page: Page) {
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

// 1. No wallet means no request to the session endpoint. It used to ask on every cold load and
//    take a 401 for an answer it could not have used.
{
  const page = await (await browser.newContext()).newPage();
  const calls: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/session")) {
      calls.push(r.method());
    }
  });
  await page.goto(APP, { waitUntil: "networkidle" });
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
  const page = await (await browser.newContext()).newPage();
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
  const page = await (await browser.newContext()).newPage();
  await withWallet(page);
  await page.goto(APP, { waitUntil: "networkidle" });
  await page
    .getByRole("button", { name: /Verify wallet/ })
    .click({ timeout: 20_000 });
  await page.getByRole("textbox").first().waitFor({ timeout: 30_000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  let flashed = false;
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(80);
    if (await page.getByRole("button", { name: "Connect wallet" }).count()) {
      flashed = true;
    }
  }
  check("a reload does not flash the gate", !flashed);
  check(
    "and lands back in the app",
    (await page.getByRole("textbox").count()) > 0,
  );
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
  const page = await ctx.newPage();
  await withWallet(page);
  await page.goto(APP, { waitUntil: "networkidle" });
  await page
    .getByRole("button", { name: /Verify wallet/ })
    .click({ timeout: 20_000 });
  await page.getByRole("textbox").first().waitFor({ timeout: 30_000 });

  const jar = (await ctx.cookies()).filter((c) => c.name === "helico_session");
  check("the session cookie is stored", jar.length === 1);
  check(
    "and it is not third-party",
    jar[0]?.sameSite === "Lax",
    `SameSite=${jar[0]?.sameSite}`,
  );

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  check(
    "still signed in after a reload, third-party cookies blocked",
    (await page.getByRole("textbox").count()) > 0,
  );
  await strict.close();
}

// 5. The front door leads with the mandate, not with a box offering to swap. This is the one a
//    judge sees first, and it regressed once already by being the conversation.
{
  const page = await (await browser.newContext()).newPage();
  await withWallet(page);
  await page.goto(APP, { waitUntil: "networkidle" });
  await page
    .getByRole("button", { name: /Verify wallet/ })
    .click({ timeout: 20_000 });
  await page
    .getByRole("heading", { name: /limits it works inside/ })
    .waitFor({ timeout: 30_000 });

  const text = (await page.locator("body").innerText()).trim();
  check(
    "the front door leads with the mandate",
    /limits it works inside/.test(text),
  );
  check(
    "it lists the authority on offer",
    /What it may be allowed to do/.test(text),
  );
  check("where the capital sits", /Where your capital sits/.test(text));
  // The three empty states look alike from outside and one of them is a broken build. With no
  // factory address configured, the panel has to say that rather than render a figure — a screen
  // that invents a balance is the failure the rules name, and an empty one is the smaller cost.
  check(
    "and it says so rather than inventing a balance",
    /No account factory is deployed yet/.test(text),
  );
  check("the limits themselves", /The limits you set/.test(text));
  check("and the sentences it answers", /What you can ask it/.test(text));
  check("and which capabilities are not wired", /not wired yet/.test(text));
  check(
    "the composer is not on it",
    (await page.getByPlaceholder(/Ask anything/i).count()) === 0,
  );

  // A grant nobody has wired must be genuinely unmovable rather than merely dimmed. At most one
  // switch on this page is operable — the real one — and it is only operable when a vault and a
  // wallet are both present, so "none" is also correct here.
  const switches = page.getByRole("switch");
  const total = await switches.count();
  let operable = 0;
  for (let i = 0; i < total; i++) {
    if (await switches.nth(i).isEnabled()) {
      operable++;
    }
  }
  check("more than one capability is shown", total > 1, `${total} switches`);
  check(
    "and at most one of them can be operated",
    operable <= 1,
    `${operable} operable`,
  );

  await page.getByRole("link", { name: /Swap/ }).first().click();
  await page.waitForTimeout(2000);
  check(
    "an ask opens the conversation",
    (await page.getByPlaceholder(/Ask anything/i).count()) > 0,
  );
  check("which lives at /chat", new URL(page.url()).pathname === "/chat");
}

await browser.close();
if (failures.length) {
  console.error(`\n${failures.length} failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nall browser checks passed");
