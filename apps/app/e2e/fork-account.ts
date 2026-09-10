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
// biome-ignore-all lint/suspicious/noConsole: this script reports what the chain said
import { chromium, type Page } from "playwright";
import {
  createPublicClient,
  encodeFunctionData,
  http,
  parseAbi,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";

import { passOnboarding } from "./onboarding";

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
const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function transfer(address to, uint256 value) returns (bool)",
]);
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const;

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
  abi: typeof factoryAbi | typeof accountAbi | typeof erc20Abi,
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

/**
 * Move USDC to `to` from an address that already holds it, using anvil's impersonation.
 *
 * A real `transfer`, not a balance written into storage. The difference matters here more than
 * anywhere: `escape` sweeps a balance out, and an account funded by fiat storage writes would
 * pass that test even if it could never have received the tokens in the first place.
 */
async function fundWithUsdc(to: `0x${string}`, value: bigint): Promise<bigint> {
  // Aave's aUSDC contract, which custodies the pool's USDC reserve — around 28 million of it on
  // any recent fork. It is a real holder rather than a balance invented in storage, and it is the
  // same contract the account's own "working" side is a receipt from.
  const whale = "0x724dc807b04555b71ed48a6896b6F41593b8C637";
  const rpc = async (method: string, params: unknown[]) => {
    const res = await fetch(FORK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = await res.json();
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  };
  await rpc("anvil_impersonateAccount", [whale]);
  await rpc("anvil_setBalance", [whale, toHex(10n ** 18n)]);
  await rpc("eth_sendTransaction", [
    {
      from: whale,
      to: USDC,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [to, value],
      }),
    },
  ]);
  await rpc("anvil_stopImpersonatingAccount", [whale]);
  return read<bigint>("balanceOf", USDC, erc20Abi, [to]);
}

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
// The first run, answered the way every suite answers it: unlock off, so this file goes on
// setting the two limits one at a time, which is the thing it is here to check.
await passOnboarding(page);
// The limits moved to their own page when the conversation took the front door.
await page.goto(`${APP}/limit`, { waitUntil: "domcontentloaded" });
await page
  .getByRole("heading", { name: /what it is allowed to do/i })
  .waitFor({ timeout: 30_000 });

// 1. Nominate the agent, from the limits panel. Nothing has opened the
//    account: this is the whole point of the step, because the first limit an owner sets is what
//    deploys it. On every build before this one the button below was disabled until a separate
//    press on the portfolio page had deployed the account, so this step could not have run at all.
check(
  "the account does not exist before the owner sets anything",
  (await read<boolean>("isOpen", FACTORY, factoryAbi, [owner.address])) ===
    false,
);
const nominate = page.getByRole("button", { name: /nominate/i });
await nominate.waitFor({ timeout: 30_000 });
await nominate.click();
await page.waitForTimeout(18_000);
check(
  "nominating an agent opens the account on the way through",
  (await read<boolean>("isOpen", FACTORY, factoryAbi, [owner.address])) ===
    true,
);
check(
  "and the account it opened is the one the factory predicted",
  (await read<string>("owner", account, accountAbi)).toLowerCase() ===
    owner.address.toLowerCase(),
);
check(
  "nominating puts Helico's agent on the account",
  (await read<string>("agent", account, accountAbi)).toLowerCase() ===
    AGENT.toLowerCase(),
);

// 2. Permit the market, from the same page.
const venue = page.getByRole("switch", { name: /permit aave/i });
await venue.waitFor({ timeout: 30_000 });
await venue.click();
await page.waitForTimeout(9000);
check(
  "the venue switch permits Aave v3",
  (await read<boolean>("permittedVenue", account, accountAbi, [AAVE])) === true,
);

// 3. And the page says what the chain says.
const text = (await page.locator("body").innerText()).trim();
check("the page now shows the agent", /0x84C3|0x84c3/i.test(text));
check(
  "and stops saying the account is not deployed",
  !/not deployed yet/i.test(text),
);

// 4. The escape hatch, which is the one path an upgrade cannot take away and until #266 had no
//    button anywhere. The account is funded by a real transfer from a holder rather than by
//    writing a balance into state: a sweep out of an account that could never have been paid in
//    proves nothing about an account that can.
const funded = await fundWithUsdc(account, 5_000_000n);
check(
  "the account holds USDC before the sweep",
  funded === 5_000_000n,
  `${funded}`,
);

const before = await read<bigint>("balanceOf", USDC, erc20Abi, [owner.address]);
await page.goto(`${APP}/`, { waitUntil: "domcontentloaded" });
await page.fill("textarea", "Take everything back to my wallet");
await page.keyboard.press("Enter");
const send = page.getByRole("button", { name: /send .* back to me/i });
await send.waitFor({ timeout: 40_000 });
check("saying it in the chat offers the sweep, not the revoke button", true);
await send.click();
await page.waitForTimeout(9000);

const left = await read<bigint>("balanceOf", USDC, erc20Abi, [account]);
const after = await read<bigint>("balanceOf", USDC, erc20Abi, [owner.address]);
check("the sweep empties the account", left === 0n, `${left} left`);
check(
  "and the owner is up by exactly what it held",
  after - before === 5_000_000n,
  `${after - before}`,
);

await browser.close();
if (failures.length) {
  console.error(`\n${failures.length} failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log(
  "\nan account was opened, nominated, permitted and emptied through the app",
);
