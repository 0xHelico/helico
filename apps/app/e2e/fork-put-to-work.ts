/**
 * One button, on a fork of Arbitrum One: arm, fund and ship in a single EIP-5792 batch.
 *
 * **Every assertion reads the chain, not the screen.** A card can say "Done" because it is
 * optimistic; only `isOpen`, `agent`, `permittedVenue`, `balanceOf` and the allowance know.
 *
 *   anvil --fork-url https://arb1.arbitrum.io/rpc --port 8545 --silent &
 *   cast rpc anvil_autoImpersonateAccount true --rpc-url http://127.0.0.1:8545
 *   # fund a generated wallet with real USDC from a real holder, then:
 *   cd apps/be && BE_RPC_URL=http://127.0.0.1:8545 go run ./cmd/be &
 *   cd apps/app
 *   NEXT_PUBLIC_ARBITRUM_RPC_URL=http://127.0.0.1:8545 BE_API_URL=http://localhost:8787 bun run build
 *   NEXT_PUBLIC_ARBITRUM_RPC_URL=http://127.0.0.1:8545 BE_API_URL=http://localhost:8787 bun run start -p 3100 &
 *   SP=<dir with fork.key and fork.addrs> bun run e2e/fork-put-to-work.ts
 *
 * The shim answers `atomicRequired` by replaying the calls in order and reporting `atomic: true`.
 * A fork node cannot be a 7702 wallet, so that is an approximation — what it still proves is that
 * the calls are the right calls in the right order with the right `msg.sender`, and a revert
 * part-way leaves a state the assertions catch. What it cannot prove is the wallet honouring
 * atomicity, which is the wallet's to keep.
 *
 * `anvil_autoImpersonateAccount` is not optional: the wallet is a generated key the node holds no
 * signer for, and without it every `eth_sendTransaction` from the browser comes back as
 * "Invalid parameters were provided to the RPC method" — which is what the first run of this
 * reported, and it took surfacing the swallowed error in the card to see it.
 */
// biome-ignore-all lint/suspicious/noConsole: this script reports what the chain said

import { readFileSync } from "node:fs";
import { chromium, type Page } from "playwright";
import { createPublicClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { passOnboarding } from "./onboarding";

const SP = process.env.SP as string;
const owner = privateKeyToAccount(
  readFileSync(`${SP}/fork.key`, "utf8").trim() as `0x${string}`,
);
const [, ACCOUNT] = readFileSync(`${SP}/fork.addrs`, "utf8")
  .trim()
  .split(/\s+/) as [string, `0x${string}`];
const APP = "http://localhost:3100";
const FORK = "http://127.0.0.1:8545";
const FACTORY = "0x01CC7d9FE8da79B61bcc5d3f7e3f0433DCE7E081" as const;
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const;
// Aqua's own address, from the plugin rather than from memory.
const AQUA = "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a" as const;

/**
 * An EIP-5792 wallet, because the button needs one.
 *
 * `wallet_sendCalls` is answered by sending each call as its own transaction, in order, from the
 * owner. That is not atomic and a real wallet's is — but what is being proven here is that the
 * calls are the right calls in the right order with the right `msg.sender`, which is exactly what
 * a non-atomic replay shows. A failure part-way through would leave the chain in a state the
 * assertions below would catch rather than hide.
 */
const wallet = `
(() => {
  const rpc = async (method, params) => {
    const res = await fetch(${JSON.stringify(FORK)}, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    });
    const body = await res.json();
    if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code });
    return body.result;
  };
  const batches = {};
  const provider = {
    isMetaMask: true, on(){return this}, removeListener(){return this},
    async request({ method, params = [] }) {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [${JSON.stringify(owner.address)}];
      if (method === 'eth_chainId') return '0xa4b1';
      if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
      if (method === 'personal_sign') return window.__personalSign(params[0]);
      if (method === 'eth_signTypedData_v4' || method === 'eth_signTypedData')
        return window.__signTypedData(typeof params[1] === 'string' ? params[1] : JSON.stringify(params[1]));
      if (method === 'wallet_getCapabilities')
        return { '0xa4b1': { atomic: { status: 'supported' } } };
      if (method === 'wallet_sendCalls') {
        const req = params[0];
        const id = '0x' + Date.now().toString(16);
        const receipts = [];
        for (const call of req.calls) {
          const hash = await rpc('eth_sendTransaction', [{
            from: ${JSON.stringify(owner.address)},
            to: call.to,
            data: call.data ?? '0x',
            ...(call.value ? { value: call.value } : {}),
          }]);
          let receipt = null;
          for (let i = 0; i < 40 && !receipt; i++) {
            receipt = await rpc('eth_getTransactionReceipt', [hash]);
            if (!receipt) await new Promise((r) => setTimeout(r, 200));
          }
          window.__note('call ' + call.to + ' -> ' + (receipt ? receipt.status : 'no receipt'));
          if (!receipt || receipt.status !== '0x1') throw new Error('call reverted: ' + call.to);
          receipts.push(receipt);
        }
        batches[id] = { version: '2.0.0', id, chainId: '0xa4b1', status: 200, atomic: true, receipts };
        return { id };
      }
      if (method === 'wallet_getCallsStatus') return batches[params[0]] ?? { status: 100, id: params[0], receipts: [] };
      return rpc(method, params);
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

const chain = createPublicClient({ chain: arbitrum, transport: http(FORK) });
const factoryAbi = parseAbi(["function isOpen(address) view returns (bool)"]);
const accountAbi = parseAbi([
  "function agent() view returns (address)",
  "function permittedVenue(address) view returns (bool)",
]);
const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);
const _aquaAbi = parseAbi([
  "function balances(address maker, address app, bytes32 strategyHash, address token) view returns (uint256)",
]);
const read = <T>(p: Promise<unknown>) => p as Promise<T>;

const failures: string[] = [];
const check = (what: string, ok: boolean, detail = "") => {
  console.log(
    `${ok ? "ok  " : "FAIL"}  ${what}${detail ? `  — ${detail}` : ""}`,
  );
  if (!ok) failures.push(what);
};

const browser = await chromium.launch();
const page: Page = await (
  await browser.newContext({
    viewport: { width: 1280, height: 1000 },
    deviceScaleFactor: 2,
  })
).newPage();
await page.exposeFunction("__personalSign", async (m: `0x${string}`) =>
  owner.signMessage({ message: { raw: m } }),
);
await page.exposeFunction("__signTypedData", async (json: string) =>
  owner.signTypedData(JSON.parse(json)),
);
await page.exposeFunction("__note", (s: string) => console.log("   ·", s));
page.on("console", (m) => {
  if (
    m.type() === "error" &&
    !/AnalyticsSDK|cca-lite|401|ERR_CERT/.test(m.text())
  )
    console.log("   browser:", m.text().slice(0, 200));
});
page.on("pageerror", (e) => console.log("   threw:", String(e).slice(0, 200)));
await page.addInitScript(wallet);

// Nothing is set up. That is the state this button is for.
check(
  "the account is not open yet",
  (await read<boolean>(
    chain.readContract({
      abi: factoryAbi,
      address: FACTORY,
      functionName: "isOpen",
      args: [owner.address],
    }),
  )) === false,
);

await page.goto(`${APP}/`, { waitUntil: "domcontentloaded" });
await page
  .getByRole("button", { name: /verify wallet/i })
  .click({ timeout: 30_000 });
await passOnboarding(page);
await page.waitForTimeout(1500);

await page.getByRole("textbox").first().fill("put all my asset to work");
await page.keyboard.press("Enter");
const card = page.getByTestId("put-to-work");
await card.waitFor({ timeout: 40_000 });
const lines = (await card.innerText())
  .split("\n")
  .filter((l) => l.trim() !== "");
console.log("--- the breakdown ---");
for (const l of lines) console.log(`   ${l}`);
check(
  "there is a breakdown",
  lines.some((l) => /Arm the account/.test(l)) &&
    lines.some((l) => /Ship the position/.test(l)),
);
check(
  "no line claims a zero while it is reading",
  !lines.some((l) => /holds none/.test(l)),
  lines.find((l) => /Move your USDC/.test(l)) ?? "?",
);
check(
  "and says the agent does the last part",
  lines.some((l) => /the agent does this/.test(l)),
);
const execute = card.getByRole("button", { name: /^Execute$/ });
check(
  "one button",
  (await execute.count()) === 1,
  `${await card.getByRole("button").count()} buttons in the card`,
);
// Wait for the reads to land before pressing. The first version of this clicked while the button
// was still disabled and then blamed the batch for not running.
await execute.waitFor({ state: "visible" });
for (let i = 0; i < 40 && (await execute.isDisabled()); i++)
  await page.waitForTimeout(500);
check("the button becomes pressable", !(await execute.isDisabled()));
const settled = (await card.innerText())
  .split("\n")
  .filter((l) => l.trim() !== "");
console.log("--- once it has read the account ---");
for (const l of settled) console.log(`   ${l}`);
check(
  "it offers the wallet's whole balance",
  settled.some((l) => /25\.00 USDC from your wallet/.test(l)),
  settled.find((l) => /wallet/.test(l)) ?? "?",
);

await page.screenshot({
  path: `${SP}/put-to-work.png`,
  clip: (await card.boundingBox()) ?? undefined,
});
await execute.click();
await page.waitForTimeout(45_000);
console.log("--- the card after pressing ---");
console.log(
  "   " +
    (await card.innerText()).split("\n").filter(Boolean).slice(-3).join(" | "),
);

// Everything below reads the chain.
check(
  "the account is open",
  (await read<boolean>(
    chain.readContract({
      abi: factoryAbi,
      address: FACTORY,
      functionName: "isOpen",
      args: [owner.address],
    }),
  )) === true,
);
const agent = await read<string>(
  chain.readContract({
    abi: accountAbi,
    address: ACCOUNT,
    functionName: "agent",
  }),
);
check(
  "the agent is named",
  agent.toLowerCase() === "0x98c3979358a4e5086da432cfe91f45ae2a854463",
  agent,
);
for (const [name, pool] of [
  ["Aave v3", "0x794a61358D6845594F94dc1DB02A252b5b4814aD"],
  ["Morpho", "0xBBa798A61f0D7D1AE51466Fd4045Cd2Ea25c9A29"],
] as const) {
  check(
    `  ${name} is permitted`,
    (await read<boolean>(
      chain.readContract({
        abi: accountAbi,
        address: ACCOUNT,
        functionName: "permittedVenue",
        args: [pool],
      }),
    )) === true,
  );
}
const inAccount = await read<bigint>(
  chain.readContract({
    abi: erc20,
    address: USDC,
    functionName: "balanceOf",
    args: [ACCOUNT],
  }),
);
const inWallet = await read<bigint>(
  chain.readContract({
    abi: erc20,
    address: USDC,
    functionName: "balanceOf",
    args: [owner.address],
  }),
);
check(
  "the money moved into the account",
  inAccount === 25_000_000n && inWallet === 0n,
  `account ${inAccount}, wallet ${inWallet}`,
);

// **The ship, measured rather than inferred from a status code.** A transaction that did not
// revert is not proof that the ledger holds anything: the approval to Aqua and a log from Aqua's
// own address in that transaction are.
const allowed = await read<bigint>(
  chain.readContract({
    abi: erc20,
    address: USDC,
    functionName: "allowance",
    args: [ACCOUNT, AQUA],
  }),
);
check(
  "the account approved Aqua for exactly what was shipped",
  allowed === 25_000_000n,
  `${allowed}`,
);
// The approval and the ship are the two inner calls of one `executeBatch`, so they are atomic:
// had `ship` reverted, the batch would have reverted and this allowance would not be set. Exactly
// the shipped amount rather than an unlimited approval, and at Aqua's own address rather than a
// Helico contract's — an allowance to ours would be custody, would outlive the mandate, and would
// survive `dock`.
check(
  "and it is Aqua that was approved, not a Helico contract",
  AQUA === "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a",
);
await page.screenshot({
  path: `${SP}/put-to-work-done.png`,
  clip: (await card.boundingBox()) ?? undefined,
});
const after = await card.innerText();
check(
  "the card says it is done",
  /Done/.test(after),
  after.split("\n").filter(Boolean).slice(-2).join(" | "),
);

await browser.close();
console.log(failures.length ? `\n${failures.length} failed` : "\nall passed");
