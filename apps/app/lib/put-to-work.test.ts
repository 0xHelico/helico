import { describe, expect, test } from "bun:test";
import { aquaAddress, encodeMandate } from "@helico/plugin-1inch";
import {
  type Address,
  decodeFunctionData,
  erc20Abi,
  parseAbi,
  toFunctionSelector,
  zeroAddress,
} from "viem";

import { accountWriteAbi, factoryAbi } from "@/lib/account";
import { type PutToWorkInput, putToWork } from "@/lib/put-to-work";

const OWNER = "0x43F9ee1f96D460D320A762e153ea66fBa355ffC0" as Address;
const ACCOUNT = "0x8E0f7e6701c2e9b4F2591161B92c51b431591807" as Address;
const FACTORY = "0x01CC7d9FE8da79B61bcc5d3f7e3f0433DCE7E081" as Address;
const APP = "0x0524a353dfab33CD362593ae8e97707764Fb6041" as Address;
const AGENT = "0x98c3979358A4e5086Da432CfE91F45aE2A854463" as Address;
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as Address;
const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1" as Address;
const AAVE = "0x794a61358D6845594F94dc1DB02A252b5b4814aD" as Address;
const MORPHO = "0xBBa798A61f0D7D1AE51466Fd4045Cd2Ea25c9A29" as Address;
const ROUTER = "0x111111125421cA6dc452d289314280a0f8842A65" as Address;

const sel = (abi: readonly unknown[], name: string) =>
  toFunctionSelector(
    // biome-ignore lint/suspicious/noExplicitAny: test helper over parsed ABIs
    (abi as any[]).find((f) => f.type === "function" && f.name === name),
  );
const OPEN = sel(factoryAbi, "open");
const SET_AGENT = sel(accountWriteAbi, "setAgent");
const PERMIT = sel(accountWriteAbi, "permitVenue");
const TRANSFER = sel(erc20Abi, "transfer");
const batchAbi = parseAbi([
  "struct Call { address target; uint256 value; bytes data; }",
  "function executeBatch(Call[] calls) returns (bytes[])",
]);
const EXECUTE_BATCH = sel(batchAbi, "executeBatch");
const DEPOSIT = sel(parseAbi(["function deposit() payable"]), "deposit");
const shape = (calls: { to: Address; data: `0x${string}` }[]) =>
  calls.map((c) => `${c.to.toLowerCase()} ${c.data.slice(0, 10)}`);

const fresh: PutToWorkInput = {
  chainId: 42161,
  owner: OWNER,
  account: ACCOUNT,
  app: APP,
  factory: FACTORY,
  opened: false,
  armed: false,
  agent: AGENT,
  markets: [{ pool: AAVE }, { pool: MORPHO }],
  usdc: USDC,
  weth: WETH,
  wallet: 0n,
  idle: 0n,
  working: 0n,
  weth_: 0n,
  positions: [
    {
      pool: AAVE,
      asset: USDC,
      receipt: "0x724dc807b04555b71ed48a6896b6f41593b8c637",
      sharePriced: false,
    },
    { pool: MORPHO, asset: USDC, receipt: MORPHO, sharePriced: true },
  ],
  now: 1_789_300_000n,
  salt: `0x${"1".padStart(64, "0")}`,
};

describe("putToWork", () => {
  test("a wallet with nothing and no swap has nothing to send", () => {
    expect(() => putToWork(fresh)).toThrow("nothing to put to work");
  });

  test("the batch today: open, arm, move USDC in, ship — in that order, no value anywhere", () => {
    const { calls, ceiling, mandate } = putToWork({
      ...fresh,
      wallet: 1_000_000n,
    });
    expect(shape(calls)).toEqual([
      `${FACTORY.toLowerCase()} ${OPEN}`,
      `${ACCOUNT.toLowerCase()} ${SET_AGENT}`,
      `${ACCOUNT.toLowerCase()} ${PERMIT}`,
      `${ACCOUNT.toLowerCase()} ${PERMIT}`,
      `${USDC.toLowerCase()} ${TRANSFER}`,
      `${ACCOUNT.toLowerCase()} ${EXECUTE_BATCH}`,
    ]);
    expect(calls.every((c) => (c.value ?? 0n) === 0n)).toBe(true);
    expect(ceiling).toBe(1_000_000n);
    expect(mandate.maxOut0).toBe(1_000_000n);
    expect(mandate.venues).toHaveLength(2);
  });

  test("an armed, open account skips open and arming and only funds and ships", () => {
    const { calls } = putToWork({
      ...fresh,
      opened: true,
      armed: true,
      factory: undefined,
      wallet: 500_000n,
      idle: 250_000n,
      working: 250_000n,
    });
    expect(shape(calls)).toEqual([
      `${USDC.toLowerCase()} ${TRANSFER}`,
      `${ACCOUNT.toLowerCase()} ${EXECUTE_BATCH}`,
    ]);
    // The ceiling counts what is already in and what is working: a fill is covered out of the
    // receipt, not only out of idle tokens.
    expect(
      putToWork({
        ...fresh,
        opened: true,
        armed: true,
        wallet: 500_000n,
        idle: 250_000n,
        working: 250_000n,
      }).ceiling,
    ).toBe(1_000_000n);
  });

  /**
   * The one-signature-from-ETH case. The swap sits right after `open`, carries the only `value` in
   * the batch, and the mandate is sized by what the router refuses to deliver less than — not by
   * the wallet's USDC, which is zero, and not by the quote's optimistic output.
   */
  test("with a funding swap: open, swap with value, arm, ship for minAmountOut; no transfer", () => {
    const funding = {
      calls: [
        {
          to: ROUTER,
          data: "0x07ed23790000" as `0x${string}`,
          value: 400_000_000_000_000n,
        },
      ],
      minAmountOut: 999_000n,
    };
    const { calls, ceiling, mandate } = putToWork({ ...fresh, funding });
    expect(shape(calls)).toEqual([
      `${FACTORY.toLowerCase()} ${OPEN}`,
      `${ROUTER.toLowerCase()} 0x07ed2379`,
      `${ACCOUNT.toLowerCase()} ${SET_AGENT}`,
      `${ACCOUNT.toLowerCase()} ${PERMIT}`,
      `${ACCOUNT.toLowerCase()} ${PERMIT}`,
      `${ACCOUNT.toLowerCase()} ${EXECUTE_BATCH}`,
    ]);
    expect(calls[1]?.value).toBe(400_000_000_000_000n);
    expect(calls.filter((c) => (c.value ?? 0n) > 0n)).toHaveLength(1);
    expect(ceiling).toBe(999_000n);
    expect(mandate.maxOut0).toBe(999_000n);
    expect(mandate.maxOut1).toBe(0n);

    // The ship inside `executeBatch` approves and ships exactly the ceiling, to Aqua, as the account.
    const batch = decodeFunctionData({
      abi: batchAbi,
      data: calls.at(-1)?.data as `0x${string}`,
    });
    const inner = batch.args[0];
    expect(inner.at(-1)?.target.toLowerCase()).toBe(aquaAddress(42161));
    expect(inner.every((c) => c.value === 0n)).toBe(true);
    const shipped = decodeFunctionData({
      abi: parseAbi([
        "function ship(address app, bytes strategy, address[] tokens, uint256[] amounts) returns (bytes32)",
      ]),
      data: inner.at(-1)?.data as `0x${string}`,
    });
    expect(shipped.args[0].toLowerCase()).toBe(APP.toLowerCase());
    expect(shipped.args[2].map((t) => t.toLowerCase())).toEqual([
      USDC.toLowerCase(),
      WETH.toLowerCase(),
      "0x724dc807b04555b71ed48a6896b6f41593b8c637",
      MORPHO.toLowerCase(),
    ]);
    expect(shipped.args[3]).toEqual([999_000n, 0n, 999_000n, 999_000n]);
    // And the bytes shipped are the mandate, byte for byte.
    expect(shipped.args[1]).toBe(encodeMandate(mandate));
  });

  test("a funding swap that needs an approval carries both calls, in order, before arming", () => {
    const { calls } = putToWork({
      ...fresh,
      funding: {
        calls: [
          { to: WETH, data: "0x095ea7b3" },
          { to: ROUTER, data: "0x07ed2379" },
        ],
        minAmountOut: 500_000n,
      },
    });
    expect(shape(calls).map((s) => s.split(" ")[1])).toEqual([
      OPEN,
      "0x095ea7b3",
      "0x07ed2379",
      SET_AGENT,
      PERMIT,
      PERMIT,
      EXECUTE_BATCH,
    ]);
    expect(calls.every((c) => (c.value ?? 0n) === 0n)).toBe(true);
  });

  /**
   * Ether put to work as itself. Wrapped in the wallet, moved in, and the mandate's WETH side is
   * the wrapped amount — so a position that had only USDC now has both sides and can price.
   */
  test("wrapping ether: deposit with value, transfer, and a two-sided mandate", () => {
    const { calls, ceiling, mandate } = putToWork({
      ...fresh,
      opened: true,
      armed: true,
      factory: undefined,
      idle: 10_000n,
      working: 986_487n,
      wrap: { amount: 400_000_000_000_000n },
    });
    expect(shape(calls)).toEqual([
      `${WETH.toLowerCase()} ${DEPOSIT}`,
      `${WETH.toLowerCase()} ${TRANSFER}`,
      `${ACCOUNT.toLowerCase()} ${EXECUTE_BATCH}`,
    ]);
    expect(calls[0]?.value).toBe(400_000_000_000_000n);
    expect(calls.filter((c) => (c.value ?? 0n) > 0n)).toHaveLength(1);
    expect(ceiling).toBe(996_487n);
    expect(mandate.maxOut0).toBe(996_487n);
    expect(mandate.maxOut1).toBe(400_000_000_000_000n);
    const batch = decodeFunctionData({
      abi: batchAbi,
      data: calls.at(-1)?.data as `0x${string}`,
    });
    const shipped = decodeFunctionData({
      abi: parseAbi([
        "function ship(address app, bytes strategy, address[] tokens, uint256[] amounts) returns (bytes32)",
      ]),
      data: batch.args[0].at(-1)?.data as `0x${string}`,
    });
    // USDC, WETH, then the receipts: the WETH side is shipped at the wrapped amount.
    expect(shipped.args[3].slice(0, 2)).toEqual([
      996_487n,
      400_000_000_000_000n,
    ]);
  });

  test("ether alone is enough to ship: no USDC anywhere, a wrap, a mandate with a WETH side", () => {
    const { mandate, calls } = putToWork({
      ...fresh,
      wrap: { amount: 1n },
    });
    expect(mandate.maxOut0).toBe(0n);
    expect(mandate.maxOut1).toBe(1n);
    expect(shape(calls).map((s) => s.split(" ")[1])).toEqual([
      OPEN,
      DEPOSIT,
      TRANSFER,
      SET_AGENT,
      PERMIT,
      PERMIT,
      EXECUTE_BATCH,
    ]);
  });

  test("a wallet holding USDC and funding from ETH does both, and the ceiling is the sum", () => {
    const { calls, ceiling } = putToWork({
      ...fresh,
      wallet: 250_000n,
      funding: {
        calls: [{ to: ROUTER, data: "0x07ed2379", value: 1n }],
        minAmountOut: 750_000n,
      },
    });
    expect(shape(calls).map((s) => s.split(" ")[1])).toEqual([
      OPEN,
      "0x07ed2379",
      SET_AGENT,
      PERMIT,
      PERMIT,
      TRANSFER,
      EXECUTE_BATCH,
    ]);
    expect(ceiling).toBe(1_000_000n);
    // `agent` on the mandate is nobody: a fill against this app needs no designated taker.
    expect(putToWork({ ...fresh, wallet: 1n }).mandate.agent).toBe(zeroAddress);
  });
});
