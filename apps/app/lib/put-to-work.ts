import {
  mandateSetupCalls,
  ReceiptKind,
  type SwapMandate,
} from "@helico/plugin-1inch";
import {
  type Address,
  encodeFunctionData,
  erc20Abi,
  type Hex,
  parseAbi,
  zeroAddress,
} from "viem";

import { accountWriteAbi, factoryAbi } from "@/lib/account";

/**
 * The put-to-work batch, as data.
 *
 * Everything the card sends is decided here from numbers it has already read, so the shape of the
 * batch — which calls, in which order, with which `msg.sender` and which `value` — can be asserted
 * without a wallet, a chain or a browser. The card keeps the two things that need a chain: the
 * `mandateHash` cross-check against the live contract, and the send.
 *
 * **One optional swap funds the rest.** When the sentence asked to swap first, a 1inch swap goes
 * into the batch with the account as `receiver`: ETH goes in as `value`, USDC lands in the account —
 * an address `open` creates in the same batch, and an ERC-20 transfer to a CREATE2 address with no
 * code yet is an ordinary transfer — and the mandate is sized by the quote's `minAmountOut`, the
 * floor 1inch's own calldata enforces. Whatever lands above it is idle in the account, and the
 * enclave moves it on its next run. That is the one call in the batch carrying value, and the test
 * says so.
 */

const wethAbi = parseAbi(["function deposit() payable"]);

const accountBatchAbi = parseAbi([
  "struct Call { address target; uint256 value; bytes data; }",
  "function executeBatch(Call[] calls) returns (bytes[])",
]);

/** A day. Long enough for a demo, short enough that a forgotten mandate dies on its own. */
export const LIFETIME_SECONDS = 86_400n;
export const FEE_BPS = 30n;

export type Call = { to: Address; data: Hex; value?: bigint };

export type Position = {
  pool: Address;
  asset: Address;
  receipt: Address;
  sharePriced: boolean;
};

/** A swap the batch carries to fund the account, already planned against the 1inch API. */
export type FundingSwap = {
  /**
   * From the wallet, in order: the approval when the token needs one, then the router call —
   * ETH in as `value` when the token is ether — with the account as the swap's receiver.
   */
  calls: Call[];
  /** What the router will refuse to deliver less than — the number the mandate is sized by. */
  minAmountOut: bigint;
};

/**
 * Ether put to work as itself: wrapped in the wallet and moved into the account, where the
 * enclave places it in whichever WETH market pays most. Two calls, both from the wallet, and the
 * only `value` in the batch. The mandate's WETH side grows by the same amount, so a position
 * that was one-sided becomes two-sided — which is the difference between a mandate that prices
 * and one `DegenerateReserves` refuses.
 */
export type FundingWrap = {
  /** Wei to wrap. The caller has already kept enough ether back for gas. */
  amount: bigint;
};

export type PutToWorkInput = {
  chainId: number;
  owner: Address;
  account: Address;
  /** The Aqua app the mandate is shipped to — `HelicoMandateSwap`. */
  app: Address;
  /** The factory to `open` on. `undefined` when the account already exists. */
  factory?: Address;
  opened: boolean;
  armed: boolean;
  /** The agent to name and the markets to permit when the account is not armed. */
  agent: Address;
  markets: readonly { pool: Address }[];
  usdc: Address;
  weth: Address;
  /** USDC in the owner's wallet, in the account, and working in venues; WETH in the account. */
  wallet: bigint;
  idle: bigint;
  working: bigint;
  weth_: bigint;
  /** The account's receipts per market, for `mandate.venues`. */
  positions: readonly Position[];
  /** Optional: the swap that funds the account inside this batch. */
  funding?: FundingSwap;
  /** Optional: ether wrapped and moved in inside this batch, put to work as WETH. */
  wrap?: FundingWrap;
  now: bigint;
  salt: Hex;
};

export type PutToWork = {
  mandate: SwapMandate;
  /** What a fill may take: everything the account will hold once this batch has run. */
  ceiling: bigint;
  calls: Call[];
};

/**
 * The calls, in the order they must run, and the mandate they ship.
 *
 * Throws on an empty batch — a wallet with nothing anywhere and no swap to change that — because
 * a button that ships a mandate for zero is a signature spent on nothing.
 */
export function putToWork(input: PutToWorkInput): PutToWork {
  const usdc = input.usdc.toLowerCase();
  const fundingOut = input.funding?.minAmountOut ?? 0n;
  const ceiling = input.wallet + input.idle + input.working + fundingOut;
  const wrapped = input.wrap?.amount ?? 0n;
  // The WETH side: what the account holds plus what this batch wraps in.
  const wethSide = input.weth_ + wrapped;
  if (ceiling <= 0n && wethSide <= 0n) {
    throw new Error("There is nothing to put to work");
  }

  // **Every market the account has a receipt for**, which since #481 is every market the batch
  // permits: `SwapMandate.venues` is immutable, and a mandate that named none could never be
  // covered out of a lending position.
  const byPool = new Map<string, SwapMandate["venues"][number]>();
  for (const p of input.positions) {
    const key = p.pool.toLowerCase();
    const existing = byPool.get(key) ?? {
      pool: p.pool,
      receipt0: zeroAddress as Address,
      receipt1: zeroAddress as Address,
      kind: p.sharePriced ? ReceiptKind.SharePriced : ReceiptKind.Rebasing,
    };
    if (p.asset.toLowerCase() === usdc) {
      existing.receipt0 = p.receipt;
    } else {
      existing.receipt1 = p.receipt;
    }
    byPool.set(key, existing);
  }
  const venues = [...byPool.values()];

  const mandate: SwapMandate = {
    maker: input.account,
    token0: input.usdc,
    token1: input.weth,
    feeBps: FEE_BPS,
    maxOut0: ceiling,
    // Whatever the account holds of the other side, plus what this batch wraps in. Naming more
    // than that would be a ceiling the ledger cannot honour, which is a quote that reverts at
    // fill time.
    maxOut1: wethSide,
    expiry: input.now + LIFETIME_SECONDS,
    agent: zeroAddress as Address,
    salt: input.salt,
    venues,
  };

  const tokens: Address[] = [input.usdc, input.weth];
  const amounts: bigint[] = [ceiling, wethSide];
  for (const v of venues) {
    for (const [receipt, cap] of [
      [v.receipt0, ceiling],
      [v.receipt1, wethSide],
    ] as const) {
      if (receipt !== zeroAddress) {
        tokens.push(receipt as Address);
        amounts.push(cap);
      }
    }
  }
  const setup = mandateSetupCalls(
    input.chainId,
    input.app,
    mandate,
    tokens,
    amounts,
  );

  const calls: Call[] = [
    // `open` has no access control and returns the existing address rather than reverting, so
    // this is skipped for the gas rather than for correctness.
    ...(input.opened || !input.factory
      ? []
      : [
          {
            to: input.factory,
            data: encodeFunctionData({
              abi: factoryAbi,
              functionName: "open",
              args: [input.owner],
            }),
          },
        ]),
    // The funding swap, straight after `open` so the account exists when the USDC arrives — not
    // required, since a transfer to a code-less address succeeds, but the order a reader expects.
    ...(input.funding?.calls ?? []),
    // Ether wrapped in the wallet and moved in: `WETH.deposit` with the value, then a transfer.
    ...(input.wrap
      ? [
          {
            to: input.weth,
            data: encodeFunctionData({
              abi: wethAbi,
              functionName: "deposit",
            }),
            value: input.wrap.amount,
          },
          {
            to: input.weth,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: "transfer",
              args: [input.account, input.wrap.amount],
            }),
          },
        ]
      : []),
    ...(input.armed
      ? []
      : [
          {
            to: input.account,
            data: encodeFunctionData({
              abi: accountWriteAbi,
              functionName: "setAgent",
              args: [input.agent],
            }),
          },
          ...input.markets.map((m) => ({
            to: input.account,
            data: encodeFunctionData({
              abi: accountWriteAbi,
              functionName: "permitVenue",
              args: [m.pool, true],
            }),
          })),
        ]),
    // The wallet's whole USDC balance. "All my assets" is the request, and a number typed into a
    // box is the thing this card exists to remove.
    ...(input.wallet > 0n
      ? [
          {
            to: input.usdc,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: "transfer",
              args: [input.account, input.wallet],
            }),
          },
        ]
      : []),
    // The approvals and the ship, as the account. They go to **Aqua**, never to a Helico
    // contract, and only for what is shipped: an allowance to our own contracts would be
    // custody, would outlive the mandate, and would survive `dock`.
    {
      to: input.account,
      data: encodeFunctionData({
        abi: accountBatchAbi,
        functionName: "executeBatch",
        args: [
          setup.map((c) => ({
            target: c.to as Address,
            value: 0n,
            data: c.data as Hex,
          })),
        ],
      }),
    },
  ];

  return { mandate, ceiling, calls };
}
