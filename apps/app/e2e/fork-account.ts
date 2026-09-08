/**
 * Opening an account through the app, on a fork of Arbitrum One.
 *
 * This is the path #234 is about: the deployed factory has never had `open` called on it, so the
 * flow a judge would take — connect, open, nominate, permit — had been exercised with `cast` and
 * never through the interface that offers it. A button that builds the wrong calldata looks
 * exactly like a button that works until somebody presses it.
 *
 * Every assertion reads the **chain**, not the screen. A page can say an account is open because
 * it is optimistic; only `isOpen` knows.
 *
 *   anvil --fork-url https://arb1.arbitrum.io/rpc --port 8545 --silent &
 *   cd apps/be && go run ./cmd/be &
 *   cd apps/app
 *   NEXT_PUBLIC_ARBITRUM_RPC_URL=http://127.0.0.1:8545 NEXT_PUBLIC_BE_API_URL=http://localhost:8787 bun run build
 *   NEXT_PUBLIC_ARBITRUM_RPC_URL=http://127.0.0.1:8545 NEXT_PUBLIC_BE_API_URL=http://localhost:8787 bun run start -p 3100 &
 *   bun run e2e/fork-account.ts
 */
import { chromium, type Page } from "playwright";
import { createPublicClient, http, parseAbi, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";

const APP = process.env.APP_URL ?? "http://localhost:3100";
const FORK = process.env.FORK_RPC_URL ?? "http://127.0.0.1:8545";
// anvil's first key. It only ever signs on a fork — never one of Helico's, which is the rule.
const KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const FACTORY = "0x01CC7d9FE8da79B61bcc5d3f7e3f0433DCE7E081" as const;
const AGENT = "0x84C3891a9693c891877aC474a90d17d29075fcAf" as const;
const AAVE = "0x794a61358D6845594F94dc1DB02A252b5b4814aD" as const;

const factoryAbi = parseAbi([
  "function accountFor(address owner) view returns (address)",
  "function isOpen(address owner) view returns (bool)",
]);
const accountAbi = parseAbi([
  "function agent() view returns (address)",
  "function permittedVenue(address pool) view returns (bool)",
  "function owner() view returns (address)",
]);

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  console.log(
    `${ok ? "  ok  " : "FAIL  "}${name}${detail ? `  — ${detail}` : ""}`,
  );
  if (!ok) failures.push(name);
};

const owner = privateKeyToAccount(KEY);
const chain = createPublicClient({ chain: arbitrum, transport: http(FORK) });

if ((await chain.getChainId()) !== arbitrum.id) {
  throw new Error("point FORK_RPC_URL at a fork of Arbitrum One");
}
const read = <T>(
  functionName: string,
  address: `0x${string}`,
  abi: typeof factoryAbi | typeof accountAbi,
  args: unknown[] = [],
) =>
  chain.readContract({
    abi,
    address,
    functionName,
    args,
  } as never) as Promise<T>;

const account = await read<`0x${string}`>("accountFor", FACTORY, factoryAbi, [
  owner.address,
]);
check(
  "the factory names an address before anything exists",
  /^0x[0-9a-f]{40}$/i.test(account),
  account,
);
check(
  "and nothing is open there yet",
  (await read<boolean>("isOpen", FACTORY, factoryAbi, [owner.address])) ===
    false,
);

// The wallet the page talks to. Reads and writes both go to the fork; anvil signs for its own
// account, so pressing a button in the page produces a real transaction on the fork.
const wallet = `
(() => {
  const send = async (method, params) => {
    const res = await fetch(${JSON.stringify(FORK)}, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    });
    const body = await res.json();
    if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code });
    return body.result;
  };
  const provider = {
    isMetaMask: true, on(){return this}, removeListener(){return this},
    async request({ method, params = [] }) {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [${JSON.stringify(owner.address)}];
      if (method === 'eth_chainId') return ${JSON.stringify(toHex(arbitrum.id))};
      if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
      if (method === 'personal_sign') return window.__personalSign(params[0]);
      if (method === 'eth_signTypedData_v4' || method === 'eth_signTypedData')
        return window.__signTypedData(typeof params[1] === 'string' ? params[1] : JSON.stringify(params[1]));
      return send(method, params);
    },
  };
  window.ethereum = provider;
  const detail = Object.freeze({
    info: { uuid: '11111111-2222-3333-4444-555555555555', name: 'Anvil',
            icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=',
            rdns: 'site.helico.anvil' },
    provider,
  });
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
})()`;

const browser = await chromium.launch();
const page: Page = await (await browser.newContext()).newPage();
await page.exposeFunction("__personalSign", async (m: `0x${string}`) =>
  owner.signMessage({ message: { raw: m } }),
);
await page.exposeFunction("__signTypedData", async (json: string) =>
  owner.signTypedData(JSON.parse(json)),
);
await page.addInitScript(wallet);

await page.goto(`${APP}/`, { waitUntil: "domcontentloaded" });
await page
  .getByRole("button", { name: /verify wallet/i })
  .click({ timeout: 30_000 });
await page
  .getByRole("heading", { name: /limits it works inside/ })
  .waitFor({ timeout: 30_000 });

// 1. Open it, from the portfolio page, which is where the account panel lives.
await page.goto(`${APP}/portfolio`, { waitUntil: "domcontentloaded" });
const open = page.getByRole("button", { name: /open this account/i });
await open.waitFor({ timeout: 30_000 });
await open.click();
await page.waitForTimeout(9000);
check(
  "pressing Open this account opens it on chain",
  (await read<boolean>("isOpen", FACTORY, factoryAbi, [owner.address])) ===
    true,
);
check(
  "and the account it opened is the one the factory predicted",
  (await read<string>("owner", account, accountAbi)).toLowerCase() ===
    owner.address.toLowerCase(),
);

// 2. Nominate the agent, from the limits panel on the front page.
await page.goto(`${APP}/`, { waitUntil: "domcontentloaded" });
const nominate = page.getByRole("button", { name: /nominate/i });
await nominate.waitFor({ timeout: 30_000 });
await nominate.click();
await page.waitForTimeout(9000);
check(
  "nominating puts Helico's agent on the account",
  (await read<string>("agent", account, accountAbi)).toLowerCase() ===
    AGENT.toLowerCase(),
);

// 3. Permit the market, from the page.
const venue = page.getByRole("switch", { name: /permit aave/i });
await venue.waitFor({ timeout: 30_000 });
await venue.click();
await page.waitForTimeout(9000);
check(
  "the venue switch permits Aave v3",
  (await read<boolean>("permittedVenue", account, accountAbi, [AAVE])) === true,
);

// 4. And the page says what the chain says.
const text = (await page.locator("body").innerText()).trim();
check("the page now shows the agent", /0x84C3|0x84c3/i.test(text));
check("and stops saying the account is not open", !/not open yet/i.test(text));

await browser.close();
if (failures.length) {
  console.error(`\n${failures.length} failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nan account was opened, nominated and permitted through the app");
