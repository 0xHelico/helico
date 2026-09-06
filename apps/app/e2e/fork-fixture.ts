/**
 * Everything the mandate page needs to be exercised for real, on a fork of Arbitrum One.
 *
 *   anvil --fork-url https://arb1.arbitrum.io/rpc --port 8545 --silent &
 *   bun run fixture -- 0xYourTestAddress
 *
 * It deploys the vault from `contracts/script/Deploy.s.sol`, finds a live Uniswap v4 position
 * that still holds liquidity, and moves it to the address you name by impersonating its owner.
 * Nothing here touches a real chain: `anvil_impersonateAccount` only exists on a fork.
 *
 * It prints NEXT_PUBLIC_VAULT_ADDRESS and the position number to use.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { positionManagerAbi } from "@helico/plugin-cre/abi";
import { addresses } from "@helico/plugin-uniswap";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  erc721Abi,
  http,
  parseEther,
  toHex,
} from "viem";
import { arbitrum } from "viem/chains";

const RPC = process.env.FORK_RPC_URL ?? "http://127.0.0.1:8545";
// anvil's first key. It only ever signs on a fork, and only to run this script.
const DEPLOYER_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const AGENT = "0x1111111111111111111111111111111111111111";

const recipient = process.argv[2] as Address | undefined;
if (!recipient?.startsWith("0x")) {
  throw new Error("Usage: bun run fixture -- 0xAddressToGiveThePositionTo");
}

const transport = http(RPC);
const client = createPublicClient({ chain: arbitrum, transport });

const chainId = await client.getChainId();
if (chainId !== arbitrum.id) {
  throw new Error(`Expected a fork of Arbitrum One, got chain ${chainId}`);
}

// Deploying the real script rather than a stub: the point is to exercise what will be
// deployed, initialiser and roles included.
const deploy = spawnSync(
  "forge",
  [
    "script",
    "script/Deploy.s.sol:Deploy",
    "--rpc-url",
    RPC,
    "--private-key",
    DEPLOYER_KEY,
    "--broadcast",
  ],
  {
    cwd: fileURLToPath(new URL("../../../contracts", import.meta.url)),
    env: { ...process.env, AGENT_ADDRESS: AGENT },
    encoding: "utf8",
  },
);
if (deploy.status !== 0) {
  throw new Error(`forge script failed:\n${deploy.stderr}`);
}
const vault = deploy.stdout
  .match(/vault \(proxy\)\s+(0x[0-9a-fA-F]{40})/)?.[1] as Address | undefined;
if (!vault) {
  throw new Error(`No vault address in the deploy output:\n${deploy.stdout}`);
}

const positionManager = addresses(arbitrum.id).positionManager;
const next = await client.readContract({
  address: positionManager,
  abi: [
    {
      type: "function",
      name: "nextTokenId",
      stateMutability: "view",
      inputs: [],
      outputs: [{ type: "uint256" }],
    },
  ] as const,
  functionName: "nextTokenId",
});

// Backwards from the newest, because a recent position is the most likely to still hold
// liquidity. A burned or empty one is no use: the mandate caps what may move by what is there.
let found: { tokenId: bigint; owner: Address; liquidity: bigint } | undefined;
for (let id = next - 1n; id > next - 400n && !found; id -= 1n) {
  try {
    const [owner, liquidity] = await Promise.all([
      client.readContract({
        address: positionManager,
        abi: erc721Abi,
        functionName: "ownerOf",
        args: [id],
      }),
      client.readContract({
        address: positionManager,
        abi: positionManagerAbi,
        functionName: "getPositionLiquidity",
        args: [id],
      }),
    ]);
    if (liquidity > 0n) {
      found = { tokenId: id, owner, liquidity };
    }
  } catch {
    // Burned, or never minted. Try the one before it.
  }
}
if (!found) {
  throw new Error("No position with liquidity in the last 400 token ids");
}

await client.request({
  method: "anvil_impersonateAccount" as never,
  params: [found.owner] as never,
});
await client.request({
  method: "anvil_setBalance" as never,
  params: [found.owner, toHex(parseEther("1"))] as never,
});
const asOwner = createWalletClient({
  account: found.owner,
  chain: arbitrum,
  transport,
});
const hash = await asOwner.writeContract({
  address: positionManager,
  abi: erc721Abi,
  functionName: "transferFrom",
  args: [found.owner, recipient, found.tokenId],
});
await client.waitForTransactionReceipt({ hash });
await client.request({
  method: "anvil_stopImpersonatingAccount" as never,
  params: [found.owner] as never,
});

console.log(`NEXT_PUBLIC_VAULT_ADDRESS=${vault}`);
console.log(`POSITION_TOKEN_ID=${found.tokenId}`);
console.log(`POSITION_LIQUIDITY=${found.liquidity}`);
console.log(`owner is now ${recipient}`);
