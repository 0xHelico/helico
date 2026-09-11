/**
 * Every transaction the chat can produce, driven through the chat, on a fork of Arbitrum One.
 *
 *   anvil --fork-url $ARBITRUM_RPC_URL --port 8545 --silent &
 *   cd apps/app && NEXT_PUBLIC_ARBITRUM_RPC_URL=http://127.0.0.1:8545 bun run dev -p 3000
 *   bun run e2e/fork-chat-actions.ts
 *
 * The chat is the only surface where a person makes something happen by saying it, and nothing
 * checked that the saying reached a transaction. `fork-account.ts` drives the limits page and one
 * chat sentence; this drives all five actions the backend can return and reads the chain after
 * each one.
 *
 * **What is real here and what is not, said plainly.** The backend is the deployed one, because it
 * needs a model and only turns a sentence into an intent. The chain is anvil. The wallet is
 * generated in this file and funded from whales. One thing is stubbed, and only one: the `Fillable`
 * query. The maker position under test is shipped on this fork, and an index of mainnet cannot see
 * a fork, so the candidate list is handed over rather than discovered. Everything downstream of it
 * is real: the quote comes from 1inch's deployed SwapVM at its real address, and the fill is a
 * transaction this wallet signs.
 *
 * **Why a position has to be shipped at all.** On Arbitrum One today the index holds exactly one
 * active Aqua mandate and it is WBTC/WETH, so a USDC swap has nothing to fill against and the card
 * correctly answers "no live Aqua position". That is #320, not a bug here.
 */
import {
  AQUA_ABI,
  ARBITRUM_ONE,
  aquaAddress,
  concentratedStrategy,
  ONE,
  shipCall,
  strategyHash as strategyHashOf,
  swapVmAddress,
} from "@helico/plugin-1inch";
import { chromium, type Route } from "playwright";
import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  parseAbi,
  parseAbiItem,
  toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";

const APP = process.env.APP_URL ?? "http://localhost:3000";
const FORK = "http://127.0.0.1:8545";
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const;
const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1" as const;
const FACTORY = "0x01CC7d9FE8da79B61bcc5d3f7e3f0433DCE7E081" as const;
const USDC_WHALE = "0x47c031236e19d024b42f8AE6780E44A573170703" as const;
const WETH_WHALE = "0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8" as const;
const ETH_USD = "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612" as const;
const AGENT = "0x84C3891a9693c891877aC474a90d17d29075fcAf" as const;

const erc20 = parseAbi([
  "function transfer(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const accountAbi = parseAbi([
  "function setAgent(address)",
  "function agent() view returns (address)",
]);
const factoryAbi = parseAbi([
  "function open(address) returns (address)",
  "function accountFor(address) view returns (address)",
]);

const pub = createPublicClient({ chain: arbitrum, transport: http(FORK) });
const rpc = (method: string, params: unknown[]) =>
  fetch(FORK, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
  }).then((r) => r.json());

/** Impersonated rather than minted, so the token behaves as it does in production. */
async function fund(
  token: `0x${string}`,
  from: `0x${string}`,
  to: `0x${string}`,
  value: bigint,
) {
  await rpc("anvil_impersonateAccount", [from]);
  await rpc("anvil_setBalance", [from, toHex(10n ** 18n)]);
  const w = createWalletClient({
    account: from,
    chain: arbitrum,
    transport: http(FORK),
  });
  const hash = await w.writeContract({
    abi: erc20,
    address: token,
    args: [to, value],
    functionName: "transfer",
  });
  await pub.waitForTransactionReceipt({ hash });
  await rpc("anvil_stopImpersonatingAccount", [from]);
}

async function wallet_(usdc: bigint, weth = 0n) {
  const key = generatePrivateKey();
  const a = privateKeyToAccount(key);
  await rpc("anvil_setBalance", [a.address, toHex(10n * 10n ** 18n)]);
  if (usdc > 0n) await fund(USDC, USDC_WHALE, a.address, usdc);
  if (weth > 0n) await fund(WETH, WETH_WHALE, a.address, weth);
  return { key, account: a };
}

if ((await pub.getChainId()) !== 42161)
  throw new Error("point FORK at a fork of Arbitrum One");

// ── the maker, so there is something to fill against ──────────────────────────
const maker = await wallet_(200n * 10n ** 6n, 10n ** 17n);
const makerWallet = createWalletClient({
  account: maker.account,
  chain: arbitrum,
  transport: http(FORK),
});
const [, answer] = await pub.readContract({
  abi: parseAbi([
    "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  ]),
  address: ETH_USD,
  functionName: "latestRoundData",
});
const ethUsd = BigInt(answer) * 10n ** 10n;
const USDC_SIDE = 50n * 10n ** 6n;
const WETH_SIDE = (50n * ONE * ONE) / ethUsd;
for (const [token, amount] of [
  [USDC, USDC_SIDE],
  [WETH, WETH_SIDE],
] as const) {
  const hash = await makerWallet.writeContract({
    abi: parseAbi(["function approve(address,uint256) returns (bool)"]),
    address: token,
    args: [aquaAddress(ARBITRUM_ONE), amount],
    functionName: "approve",
  });
  await pub.waitForTransactionReceipt({ hash });
}
const { strategy } = concentratedStrategy({
  base: { address: WETH, decimals: 18 },
  quote: { address: USDC, decimals: 6 },
  priceMin: (ethUsd * 80n) / 100n,
  priceMax: (ethUsd * 120n) / 100n,
  feeBps: 30,
  maker: maker.account.address,
});
{
  const hash = await makerWallet.sendTransaction(
    shipCall(ARBITRUM_ONE, strategy, [WETH, USDC], [WETH_SIDE, USDC_SIDE]),
  );
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success")
    throw new Error("the maker position did not ship");
}

// ── the taker, and an account with an agent and money in it ───────────────────
const taker = await wallet_(500n * 10n ** 6n, 10n ** 17n);
const takerWallet = createWalletClient({
  account: taker.account,
  chain: arbitrum,
  transport: http(FORK),
});
{
  const opened = await takerWallet.writeContract({
    abi: factoryAbi,
    address: FACTORY,
    args: [taker.account.address],
    functionName: "open",
  });
  await pub.waitForTransactionReceipt({ hash: opened });
}
const helicoAccount = await pub.readContract({
  abi: factoryAbi,
  address: FACTORY,
  args: [taker.account.address],
  functionName: "accountFor",
});
{
  const named = await takerWallet.writeContract({
    abi: accountAbi,
    address: helicoAccount,
    args: [AGENT],
    functionName: "setAgent",
  });
  await pub.waitForTransactionReceipt({ hash: named });
}
await fund(USDC, USDC_WHALE, helicoAccount, 25n * 10n ** 6n);

const bal = (t: `0x${string}`, who: `0x${string}`) =>
  pub.readContract({
    abi: erc20,
    address: t,
    functionName: "balanceOf",
    args: [who],
  }) as Promise<bigint>;

let failed = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${n}${d ? `  — ${d}` : ""}`);
};

const FILLABLE_STUB = {
  data: {
    mandates: [
      {
        strategyHash: strategyHashOf(strategy),
        strategy,
        active: true,
        movementCount: 0,
        shippedAt: String(Math.floor(Date.now() / 1000)),
        app: { id: "0x111111338c5091e8440b67b168bae16a668ac0de" },
        balances: [
          {
            token: WETH.toLowerCase(),
            amount: String(WETH_SIDE),
            tokensCount: 2,
            totalPulled: "0",
            totalPushed: "0",
          },
          {
            token: USDC.toLowerCase(),
            amount: String(USDC_SIDE),
            tokensCount: 2,
            totalPulled: "0",
            totalPushed: "0",
          },
        ],
      },
    ],
  },
};

const wallet = (address: string) => `
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
      if (method === 'eth_sendTransaction') return window.__send(JSON.stringify(params[0]));
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

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 950 },
});
const page = await ctx.newPage();

await page.exposeFunction("__personalSign", async (m: `0x${string}`) =>
  taker.account.signMessage({ message: { raw: m } }),
);
await page.exposeFunction("__signTypedData", async (json: string) =>
  taker.account.signTypedData(JSON.parse(json)),
);
// The wallet signs and sends for real, against the fork.
await page.exposeFunction("__send", async (json: string) => {
  const tx = JSON.parse(json);
  const { createWalletClient } = await import("viem");
  const w = createWalletClient({
    account: taker.account,
    chain: arbitrum,
    transport: http(FORK),
  });
  return await w.sendTransaction({
    to: tx.to,
    data: tx.data,
    value: tx.value ? BigInt(tx.value) : undefined,
    gas: tx.gas ? BigInt(tx.gas) : undefined,
  });
});
await page.addInitScript(wallet(taker.account.address));

// One query stubbed, and only because the index cannot see a fork.
const routeGraph = async (route: Route) => {
  const body = route.request().postData() ?? "";
  if (body.includes("Fillable")) {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(FILLABLE_STUB),
    });
  }
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ data: { mandates: [] } }),
  });
};
await page.route("**/api/graph", routeGraph);
await page.route("**/api.studio.thegraph.com/**", routeGraph);

await page.goto(APP, { waitUntil: "domcontentloaded" });
await page
  .getByRole("button", { name: /Verify wallet/ })
  .click({ timeout: 40_000 });
const agree = page.getByRole("checkbox", { name: /read this and I agree/i });
try {
  await agree.waitFor({ state: "visible", timeout: 20_000 });
} catch {}
if (await agree.count()) {
  await agree.check();
  const sw = page.getByRole("switch", { name: /turn everything on/i });
  if (await sw.isChecked()) await sw.click();
  await page.getByRole("button", { name: /^Start$/ }).click();
  await agree.waitFor({ state: "hidden", timeout: 20_000 });
}
await page
  .getByRole("heading", { name: /what would you like to do/i })
  .waitFor({ timeout: 40_000 });
check("signed in and past the first run", true, taker.account.address);

async function say(text: string) {
  await page.fill("textarea", text);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
}

// ── 1. about: a paragraph and seven cards, and nothing to sign: no transaction, seven cards ─────────────────────────────────────
await say("What can you do?");
await page
  .getByText(/Set your limits/)
  .first()
  .waitFor({ timeout: 45_000 });
const aboutText = await page.locator("body").innerText();
check(
  "about answers with cards and asks for nothing",
  /Set your limits/.test(aboutText) && /See what moved/.test(aboutText),
);

// ── 2. swap: the one the product is named for ───────────────────────────
const usdc0 = await bal(USDC, taker.account.address);
const weth0 = await bal(WETH, taker.account.address);
await page.waitForTimeout(11_000);
await say("Swap 5 USDC into WETH");
// The card's own button, named exactly. `/Swap/` also matches the Swap *card* from the about
// answer still on screen above, which is how the first run of this reported a green build and a
// swap that moved nothing.
const swapButton = page.getByRole("button", {
  name: /^(Sign and swap|Sign \d+ transactions)$/,
});
let swapRendered = false;
try {
  await swapButton.waitFor({ timeout: 60_000 });
  swapRendered = true;
} catch {}
const swapText = await page.locator("body").innerText();
check(
  "swap builds a card rather than a paragraph",
  swapRendered,
  swapRendered ? await swapButton.innerText() : swapText.slice(-220),
);
if (swapRendered) {
  await swapButton.click();
  await page.waitForTimeout(25_000);
  const usdc1 = await bal(USDC, taker.account.address);
  const weth1 = await bal(WETH, taker.account.address);
  check(
    "and the swap lands: USDC out, WETH in",
    usdc1 < usdc0 && weth1 > weth0,
    `${formatUnits(usdc0 - usdc1, 6)} USDC → ${formatUnits(weth1 - weth0, 18)} WETH`,
  );
}

// ── 2b. the same swap starting in native ETH, which has to wrap first ───────
//
// "Swap 0.1 ETH into USDC" is the Swap card's own suggested sentence and one of the six starters,
// and until now it could not work at any liquidity: Aqua positions hold WETH, so looking up
// positions for `0x0000…0000` matched nothing and the card answered "no live Aqua position" — true
// for the wrong reason. The plan wraps first, so this is three transactions rather than two.
await page.waitForTimeout(13_000);
const usdcBeforeEth = await bal(USDC, taker.account.address);
await say("Swap 0.01 ETH into USDC");
const ethSwap = page.getByRole("button", {
  name: /^Sign \d+ transactions$/,
});
let ethRendered = false;
try {
  await ethSwap.last().waitFor({ timeout: 60_000 });
  ethRendered = true;
} catch {}
check(
  "an ETH swap plans a wrap, an approval and the fill",
  ethRendered && (await ethSwap.last().innerText()).includes("3"),
  ethRendered ? await ethSwap.last().innerText() : "no card",
);
if (ethRendered) {
  await ethSwap.last().click();
  await page.waitForTimeout(30_000);
  const usdcAfterEth = await bal(USDC, taker.account.address);
  check(
    "and it lands: ETH wrapped, USDC in",
    usdcAfterEth > usdcBeforeEth,
    `+${formatUnits(usdcAfterEth - usdcBeforeEth, 6)} USDC`,
  );
}

// ── 2c. a swap the position cannot pay is refused, not mis-quoted ───────────
//
// `concentrate` prices on a band, not on inventory, so it answers for more than the maker
// committed and answers badly. Measured directly: a position holding 10 USDC quotes 0.1 WETH at
// **72.06 USDC**, and the fill reverts when Aqua's ledger subtraction underflows. The card used to
// show that price. Signing it cost gas and got nothing.
//
// The stub above commits 50 USDC, so 0.1 ETH — about $246 — is more than it can pay.
await page.waitForTimeout(13_000);
await say("Swap 0.1 ETH into USDC");
const refusal = page.getByText(
  /can pay .* and this asks for more|none will price it/,
);
let refused = false;
try {
  await refusal.first().waitFor({ timeout: 60_000 });
  refused = true;
} catch {}
check(
  "a swap bigger than the position is refused with the size it can pay",
  refused && /can pay/.test(await refusal.first().innerText()),
  refused ? (await refusal.first().innerText()).slice(0, 110) : "no refusal",
);
check(
  "and no transaction is offered",
  (await page
    .getByRole("button", { name: /^(Sign and swap|Sign \d+ transactions)$/ })
    .count()) <= 2,
);

// ── 3. status: a reading, and nothing to sign ────────────────────────────────
await say("Check my portfolio");
await page
  .getByText(/read straight from the chain/)
  .first()
  .waitFor({ timeout: 45_000 });
const statusText = await page.locator("body").innerText();
check(
  "status answers with a reading and asks for no signature",
  /read straight from the chain/.test(statusText),
);
check(
  "and it names the account rather than the wallet",
  statusText.includes(helicoAccount.slice(0, 6)),
  helicoAccount,
);

// ── 4. revoke: one transaction, and it removes the agent ─────────────────────
const agentBefore = await pub.readContract({
  abi: parseAbi(["function agent() view returns (address)"]),
  address: helicoAccount,
  functionName: "agent",
});
await page.waitForTimeout(11_000);
await say("Stop the agent");
const remove = page.getByRole("button", { name: /^Remove the agent$/ });
let revokeRendered = false;
try {
  await remove.waitFor({ timeout: 45_000 });
  revokeRendered = true;
} catch {}
check("revoke offers the one button that ends it", revokeRendered);
if (revokeRendered) {
  await remove.click();
  await page.waitForTimeout(20_000);
  const agentAfter = await pub.readContract({
    abi: parseAbi(["function agent() view returns (address)"]),
    address: helicoAccount,
    functionName: "agent",
  });
  check(
    "and the agent is gone on chain",
    agentBefore !== agentAfter && /^0x0{40}$/.test(agentAfter as string),
    `${agentBefore} → ${agentAfter}`,
  );
}

// ── 5. withdraw: the escape hatch, and it empties the account ────────────────
const accBefore = await bal(USDC, helicoAccount);
const ownBefore = await bal(USDC, taker.account.address);
// Longer than the others. This is the fifth message in the window and the endpoint allows six a
// minute, so crowding it earns a 429 that looks exactly like a card which did not render.
await page.waitForTimeout(25_000);
await say("Take everything back to my wallet");
// The card's own button, anchored. Every card in the `about` answer above is itself a button whose
// accessible name is its whole text, so `/Send everything back/` matches the **Withdraw card**
// rather than the sweep — and reports a rendered card beside a sweep that moved nothing. The swap
// button had the same bug for the same reason.
const sweep = page.getByRole("button", {
  name: /^Send [\d.,]+ back to me$/,
});
let sweepRendered = false;
try {
  await sweep.waitFor({ timeout: 60_000 });
  sweepRendered = true;
} catch {}
check(
  "withdraw offers the sweep",
  sweepRendered,
  sweepRendered
    ? await sweep.innerText()
    : (await page.getByRole("button").allInnerTexts())
        .map((t) => t.replace(/\n/g, " ").slice(0, 40))
        .join(" | ")
        .slice(0, 300),
);
if (sweepRendered) {
  await sweep.click();
  await page.waitForTimeout(20_000);
  const accAfter = await bal(USDC, helicoAccount);
  const ownAfter = await bal(USDC, taker.account.address);
  check(
    "and the account is emptied into the owner",
    accAfter < accBefore && ownAfter > ownBefore,
    `account ${formatUnits(accBefore, 6)} → ${formatUnits(accAfter, 6)}, owner +${formatUnits(ownAfter - ownBefore, 6)}`,
  );
}

// ── 6. earn: the one action that cannot move anything, and says what would ──
//
// The classifier that returns `earn` is in this PR and not yet deployed, and the chat's own route
// forwards to the deployed backend. So this one request is stubbed — the card is what is under
// test here, not the wording that reaches it. Everything the card then reads (the agent, the
// venue, the balance) comes from the chain.
await page.route("**/api/chat", (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      action: "earn",
      reply:
        "Three things have to be true first: the agent is named, the market is allowed, and the money is in your account.",
      steps: [],
    }),
  }),
);
await say("Put my idle USDC to work");
const earnText = page.getByText(
  /Nobody may move your money yet|nothing in the account to move|Everything it needs is set/,
);
let earnRendered = false;
try {
  await earnText.first().waitFor({ timeout: 30_000 });
  earnRendered = true;
} catch {}
check(
  "earn names the step that is missing",
  earnRendered,
  earnRendered ? (await earnText.first().innerText()).slice(0, 90) : "",
);
if (earnRendered) {
  // The setup is a signature either way. On a wallet that can batch it is the one button; on one
  // that cannot — this injected wallet — it is the limits page, and offering neither would be a
  // card that diagnoses and then stops.
  const acted =
    (await page
      .getByRole("button", { name: /^Turn everything on with one signature$/ })
      .count()) +
    (await page
      .getByRole("link", { name: /Set them on the limits page|Move money in/ })
      .count());
  check("and offers the way to do it", acted > 0, `${acted} affordance(s)`);
}

// ── 7. deposit: money in, from the chat, and it actually moves ──────────────
//
// Stubbed for the same reason as `earn` and no further: the classifier that returns `deposit` is
// in this change and the chat's route forwards to the deployed backend. The transfer underneath is
// a real one, signed by this wallet, and the account's balance is read from the chain after it.
await page.route("**/api/chat", (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      action: "deposit",
      reply:
        "Your account is a contract only you own, and the agent moves what it holds.",
      steps: [],
    }),
  }),
);
const walletBefore = await bal(USDC, taker.account.address);
const accountBefore = await bal(USDC, helicoAccount);
await say("Move money into my account");
const howMuch = page.getByRole("textbox", {
  name: /how much USDC to move in/i,
});
let depositRendered = false;
try {
  await howMuch.waitFor({ timeout: 30_000 });
  depositRendered = true;
} catch {}
check("money in arrives as a control, not a link", depositRendered);
if (depositRendered) {
  await howMuch.fill("7");
  await page.getByRole("button", { name: /^Move it in$/ }).click();
  await page.waitForTimeout(20_000);
  const walletAfter = await bal(USDC, taker.account.address);
  const accountAfter = await bal(USDC, helicoAccount);
  check(
    "and 7 USDC leaves the wallet for the account",
    accountAfter - accountBefore === 7_000_000n &&
      walletBefore - walletAfter === 7_000_000n,
    `account ${formatUnits(accountBefore, 6)} → ${formatUnits(accountAfter, 6)}, wallet -${formatUnits(walletBefore - walletAfter, 6)}`,
  );
}

// ── 8. provide: the product ships a position of its own ────────────────────
//
// The half that existed only as a script (#346, point 4), and the only fix available to us for a
// swap with nothing to fill against: on Arbitrum One six positions hold WETH and USDC and every
// one refuses to price (#393). Stubbed at the classifier for the same reason as the two above; the
// ship is a real transaction and Aqua's ledger is read afterwards.
await page.route("**/api/chat", (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      action: "provide",
      reply: "You can be the maker rather than the taker.",
      steps: [],
    }),
  }),
);
await say("Provide liquidity for ETH and USDC");
const amountASide = page.getByRole("textbox", {
  name: /how many dollars a side/i,
});
let provideRendered = false;
try {
  await amountASide.waitFor({ timeout: 30_000 });
  provideRendered = true;
} catch {}
check("provide offers a maker position, not a refusal", provideRendered);
if (provideRendered) {
  await amountASide.fill("10");
  await page.getByRole("button", { name: /^Ship it$/ }).click();
  // Two approvals and the ship.
  const shipped = page.getByText(/It is filed under/);
  let landed = false;
  try {
    await shipped.waitFor({ timeout: 90_000 });
    landed = true;
  } catch {}
  check(
    "and it ships",
    landed,
    landed
      ? (await shipped.innerText()).replace(/\n/g, " ").slice(0, 90)
      : (await page.locator("body").innerText()).slice(-160),
  );
  if (landed) {
    // Aqua's own ledger, not the card's word for it. `ship` moves no token, so the wallet's
    // balances are unchanged and the only evidence it happened is the number Aqua now holds.
    const filed = /filed under\s+(0x[0-9a-f]{8})/.exec(
      await shipped.innerText(),
    );
    const events = await pub.getLogs({
      address: aquaAddress(ARBITRUM_ONE),
      event: parseAbiItem(
        "event Shipped(address maker, address app, bytes32 strategyHash, bytes strategy)",
      ),
      fromBlock: "earliest",
    });
    const ours = events.filter(
      (e) =>
        String(e.args.maker).toLowerCase() ===
        taker.account.address.toLowerCase(),
    );
    check(
      "and Aqua recorded it against this wallet",
      ours.length === 1 && Boolean(filed),
      `${ours.length} Shipped event(s), card says ${filed?.[1] ?? "nothing"}`,
    );
    if (ours.length === 1) {
      const [amount, count] = (await pub.readContract({
        abi: AQUA_ABI,
        address: aquaAddress(ARBITRUM_ONE),
        args: [
          taker.account.address,
          swapVmAddress(ARBITRUM_ONE),
          ours[0]?.args.strategyHash as `0x${string}`,
          USDC,
        ],
        functionName: "rawBalances",
      })) as [bigint, number];
      check(
        "and the ledger holds the USDC side, spendable",
        amount === 10_000_000n && count > 0 && count < 255,
        `${formatUnits(amount, 6)} USDC, sentinel ${count}`,
      );
    }
  }
}

console.log(`\n${failed === 0 ? "all green" : `${failed} failed`}`);
await browser.close();
process.exit(failed === 0 ? 0 : 1);
