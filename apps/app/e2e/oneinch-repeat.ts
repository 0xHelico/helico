/**
 * Twelve 1inch swaps in a row, to tell a working route from a lucky one.
 *
 *   anvil --fork-url $ARBITRUM_RPC_URL --port 8545 --silent &
 *   cd apps/app && bun run dev -p 3000 &   # the proxy holds the key
 *   bun run e2e/oneinch-repeat.ts
 *
 * The fork-chat suite fills through 1inch once, and once is not evidence of reliability — one run
 * of it reported `+0 USDC` and that is what this file exists to catch. Everything here is real: the
 * quote and the calldata come from the live aggregation API through our own proxy, and each
 * transaction is signed by a freshly generated wallet and mined on the fork.
 *
 * **Why a fork at all, when the route is built for mainnet.** Because that is the interesting
 * question. 1inch quotes against the chain head and anvil is pinned thousands of blocks behind it,
 * so a route through a pool whose state moved reverts — and knowing how often that happens, at what
 * sizes, is the difference between "it works" and "it worked once". A failure here is not
 * necessarily a bug in our code; it is a number worth having either way.
 */
import { ONEINCH_NATIVE, oneInchToken } from "@helico/plugin-1inch";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  erc20Abi,
  formatUnits,
  http,
  toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";

const FORK = "http://127.0.0.1:8545";
const PROXY = process.env.APP_URL ?? "http://localhost:3000";
const USDC: Address = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const WETH: Address = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const NATIVE: Address = "0x0000000000000000000000000000000000000000";
const USDC_WHALE: Address = "0x47c031236e19d024b42f8AE6780E44A573170703";
const SLIPPAGE_BPS = 50;

const pub = createPublicClient({ chain: arbitrum, transport: http(FORK) });
const rpc = async (method: string, params: unknown[]) => {
  const body = await fetch(FORK, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
  }).then((r) => r.json());
  if (body?.error)
    throw new Error(
      `${method}: ${body.error.message}` +
        (/missing trie node|state is not available/.test(
          String(body.error.message),
        )
          ? " — the fork block has aged out, restart anvil"
          : ""),
    );
  return body;
};

if ((await pub.getChainId()) !== 42161)
  throw new Error("point FORK at a fork of Arbitrum One");
const forkBlock = await pub.getBlockNumber();
const head = await createPublicClient({
  chain: arbitrum,
  transport: http("https://arb1.arbitrum.io/rpc"),
}).getBlockNumber();
console.log(
  `fork at ${forkBlock}, chain head ${head}, drift ${head - forkBlock} blocks\n`,
);

const bal = (token: Address, who: Address) =>
  token === NATIVE
    ? pub.getBalance({ address: who })
    : (pub.readContract({
        abi: erc20Abi,
        address: token,
        args: [who],
        functionName: "balanceOf",
      }) as Promise<bigint>);

/** Exactly what `lib/oneinch-swap.ts` does, through the same proxy, with nothing stubbed. */
async function plan(
  account: Address,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
) {
  const src = oneInchToken(tokenIn);
  const dst = oneInchToken(tokenOut);
  const ask = async (path: string) => {
    const r = await fetch(`${PROXY}/api/1inch${path}`);
    const body = await r.json();
    if (!r.ok)
      throw new Error(`${body.code ?? r.status}: ${body.description ?? ""}`);
    return body;
  };
  const { address: spender } = await ask(`/swap/v6.1/42161/approve/spender`);
  const steps: { to: Address; data: `0x${string}`; value: bigint }[] = [];
  if (src !== (ONEINCH_NATIVE as Address)) {
    const allowance = (await pub.readContract({
      abi: erc20Abi,
      address: src,
      args: [account, spender as Address],
      functionName: "allowance",
    })) as bigint;
    if (allowance < amountIn) {
      const a = await ask(
        `/swap/v6.1/42161/approve/transaction?tokenAddress=${src}&amount=${amountIn}`,
      );
      steps.push({ to: a.to, data: a.data, value: BigInt(a.value) });
    }
  }
  const fill = await ask(
    `/swap/v6.1/42161/swap?src=${src}&dst=${dst}&amount=${amountIn}` +
      `&from=${account}&origin=${account}&slippage=${SLIPPAGE_BPS / 100}&disableEstimate=true`,
  );
  steps.push({
    to: fill.tx.to,
    data: fill.tx.data,
    value: BigInt(fill.tx.value),
  });
  return { quoted: BigInt(fill.dstAmount), steps };
}

const cases: { label: string; in: Address; out: Address; amount: bigint }[] = [
  { label: "0.01 ETH → USDC", in: NATIVE, out: USDC, amount: 10n ** 16n },
  { label: "0.1 ETH → USDC", in: NATIVE, out: USDC, amount: 10n ** 17n },
  { label: "0.5 ETH → USDC", in: NATIVE, out: USDC, amount: 5n * 10n ** 17n },
  { label: "1 ETH → USDC", in: NATIVE, out: USDC, amount: 10n ** 18n },
  { label: "5 USDC → WETH", in: USDC, out: WETH, amount: 5_000_000n },
  { label: "100 USDC → WETH", in: USDC, out: WETH, amount: 100_000_000n },
  { label: "1000 USDC → WETH", in: USDC, out: WETH, amount: 1_000_000_000n },
  { label: "5000 USDC → WETH", in: USDC, out: WETH, amount: 5_000_000_000n },
  { label: "0.02 ETH → USDC", in: NATIVE, out: USDC, amount: 2n * 10n ** 16n },
  { label: "250 USDC → WETH", in: USDC, out: WETH, amount: 250_000_000n },
  { label: "0.05 ETH → USDC", in: NATIVE, out: USDC, amount: 5n * 10n ** 16n },
  { label: "20 USDC → WETH", in: USDC, out: WETH, amount: 20_000_000n },
];

let filled = 0;
const failures: string[] = [];
for (const c of cases) {
  // A new wallet each time, so no case can be carried by another's allowance or leftovers.
  const account = privateKeyToAccount(generatePrivateKey());
  await rpc("anvil_setBalance", [account.address, toHex(20n * 10n ** 18n)]);
  if (c.in === USDC) {
    await rpc("anvil_impersonateAccount", [USDC_WHALE]);
    await rpc("anvil_setBalance", [USDC_WHALE, toHex(10n ** 18n)]);
    const whale = createWalletClient({
      account: USDC_WHALE,
      chain: arbitrum,
      transport: http(FORK),
    });
    const hash = await whale.writeContract({
      abi: erc20Abi,
      address: USDC,
      args: [account.address, c.amount],
      functionName: "transfer",
    });
    await pub.waitForTransactionReceipt({ hash });
    await rpc("anvil_stopImpersonatingAccount", [USDC_WHALE]);
  }
  const wallet = createWalletClient({
    account,
    chain: arbitrum,
    transport: http(FORK),
  });
  const before = await bal(c.out, account.address);
  try {
    const { quoted, steps } = await plan(
      account.address,
      c.in,
      c.out,
      c.amount,
    );
    for (const step of steps) {
      const hash = await wallet.sendTransaction({
        to: step.to,
        data: step.data,
        value: step.value,
        gas: 3_000_000n,
      });
      const receipt = await pub.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("a step reverted");
    }
    const after = await bal(c.out, account.address);
    const got = after - before;
    const dec = c.out === USDC ? 6 : 18;
    // The floor the card shows. A fill below it means the calldata's own `minReturn` was looser
    // than what the card promised, which would be a promise we do not keep.
    const floor = (quoted * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n;
    const ok = got >= floor;
    if (ok) filled += 1;
    else failures.push(`${c.label}: ${got} below the floor ${floor}`);
    console.log(
      `${ok ? "ok  " : "FAIL"}  ${c.label.padEnd(18)} ${steps.length} tx  quoted ${formatUnits(quoted, dec).padEnd(22)} got ${formatUnits(got, dec)}`,
    );
  } catch (e) {
    const why = (e instanceof Error ? e.message : String(e))
      .split("\n")[0]
      ?.slice(0, 110);
    failures.push(`${c.label}: ${why}`);
    console.log(`FAIL  ${c.label.padEnd(18)} ${why}`);
  }
}

console.log(`\n${filled} of ${cases.length} filled at or above the floor`);
for (const f of failures) console.log(`  - ${f}`);
if (filled !== cases.length) process.exit(1);
