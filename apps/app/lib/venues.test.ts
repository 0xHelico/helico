import { describe, expect, test } from "bun:test";
import type { Address, PublicClient } from "viem";

import {
  ACCOUNT_ASSETS,
  bestBps,
  KNOWN_VENUES,
  MARKETS,
  type Market,
  readMarkets,
  readVenues,
  suppliedIn,
  sweepList,
} from "./venues";

const ACCOUNT = "0x3333333333333333333333333333333333333333" as Address;
const [USDC, WETH] = ACCOUNT_ASSETS as [Address, Address];

const AAVE = "0x794a61358D6845594F94dc1DB02A252b5b4814aD" as Address;
const AUSDC = "0x724dc807b04555b71ed48a6896b6F41593b8C637" as Address;
const AWETH = "0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8" as Address;
const COMPOUND = "0x1eC57cE1DdfdC7a4EbF4F54Aedee19ab73fcBB2E" as Address;
const COMPOUND_WETH = "0xb0A125F539237b553025e2cb180f9C40B25918cD" as Address;

/**
 * A chain that behaves like the real one in the way that matters: a venue answers
 * `getReserveAToken` only for the asset it lists and **throws** for any other, exactly as the
 * deployed contracts revert with `WrongAsset`. A fake that answered everything could not tell a
 * question that was asked from one that was not.
 */
const chain = (opts: {
  permitted?: { pool: Address; allowed: boolean }[] | Error;
  lists?: Record<string, Record<string, Address>>;
  balances?: Record<string, bigint>;
  /** Underlying per share, as `previewRedeem` would answer. */
  sharePrice?: bigint;
  previewThrows?: boolean;
}) => {
  const asked: string[] = [];
  const client = {
    getLogs: async () => {
      if (opts.permitted instanceof Error) throw opts.permitted;
      return (opts.permitted ?? []).map((p) => ({
        args: { pool: p.pool, allowed: p.allowed },
      }));
    },
    readContract: async ({
      functionName,
      address,
      args,
    }: {
      functionName: string;
      address: Address;
      args?: readonly unknown[];
    }) => {
      if (functionName === "getReserveAToken") {
        const asset = String(args?.[0]).toLowerCase();
        asked.push(`${address.toLowerCase()}:${asset}`);
        const receipt = opts.lists?.[address.toLowerCase()]?.[asset];
        if (!receipt) throw new Error("WrongAsset");
        return receipt;
      }
      if (functionName === "balanceOf") {
        return opts.balances?.[address.toLowerCase()] ?? 0n;
      }
      if (functionName === "previewRedeem") {
        if (opts.previewThrows) throw new Error("no");
        return (BigInt(String(args?.[0])) * (opts.sharePrice ?? 1n)) / 1n;
      }
      throw new Error(`unmodelled ${functionName}`);
    },
  } as unknown as PublicClient;
  return { client, asked };
};

const lists = {
  [AAVE.toLowerCase()]: {
    [USDC.toLowerCase()]: AUSDC,
    [WETH.toLowerCase()]: AWETH,
  },
  [COMPOUND.toLowerCase()]: { [USDC.toLowerCase()]: COMPOUND },
  [COMPOUND_WETH.toLowerCase()]: { [WETH.toLowerCase()]: COMPOUND_WETH },
};

describe("the markets come from the account, not from a constant", () => {
  test("a venue permitted after this file was written is still found", async () => {
    // The whole point. Nothing here names the WETH venue; the account's own log does.
    const later = "0x9999999999999999999999999999999999999999" as Address;
    const { client } = chain({
      permitted: [{ pool: later, allowed: true }],
      lists: { [later.toLowerCase()]: { [USDC.toLowerCase()]: later } },
      balances: { [later.toLowerCase()]: 7n },
    });
    const { positions, source } = await readVenues(client, ACCOUNT);
    expect(source).toBe("logs");
    expect(positions.map((p) => p.pool)).toEqual([later]);
  });

  test("a revoked market is still swept, because it may still hold money", async () => {
    // `venueEverPermitted` is one-way on chain: revoking bars new deposits and never bars the way
    // out. A sweep that skipped revoked markets would strand exactly the capital an owner
    // revoking a venue is most likely to want back.
    const { client } = chain({
      permitted: [
        { pool: COMPOUND, allowed: true },
        { pool: COMPOUND, allowed: false },
      ],
      lists,
      balances: { [COMPOUND.toLowerCase()]: 5n },
    });
    const { positions } = await readVenues(client, ACCOUNT);
    expect(positions.map((p) => p.pool)).toEqual([COMPOUND]);
  });

  test("a market only ever revoked was never permitted, and is not one of them", async () => {
    // `permitVenue(pool, false)` on a market that was never allowed emits the event and leaves
    // `venueEverPermitted` false — so the account cannot have supplied to it and it is not a
    // place money can be. Counting it would put a market in the readout the owner never allowed.
    //
    // Added because a mutation found it: flipping the guard to accept any event left every other
    // test in this file green.
    const never = "0x8888888888888888888888888888888888888888" as Address;
    const { client } = chain({
      permitted: [
        { pool: AAVE, allowed: true },
        { pool: never, allowed: false },
      ],
      lists: {
        ...lists,
        [never.toLowerCase()]: { [USDC.toLowerCase()]: never },
      },
    });
    const { positions } = await readVenues(client, ACCOUNT);
    expect(positions.map((p) => p.pool)).not.toContain(never);
    expect(positions.map((p) => p.pool)).toContain(AAVE);
  });

  test("a market named twice is read once", async () => {
    const { client, asked } = chain({
      permitted: [
        { pool: AAVE, allowed: true },
        { pool: AAVE, allowed: true },
      ],
      lists,
    });
    await readVenues(client, ACCOUNT);
    expect(asked.length).toBe(ACCOUNT_ASSETS.length);
  });

  test("and when the logs cannot be read it falls back, and says so", async () => {
    // A partial sweep beats none. Silence about which one happened does not.
    const { client } = chain({ permitted: new Error("range too wide"), lists });
    const { positions, source } = await readVenues(client, ACCOUNT);
    expect(source).toBe("fallback");
    expect(new Set(positions.map((p) => p.pool))).toEqual(
      new Set([AAVE, COMPOUND, COMPOUND_WETH]),
    );
    expect(KNOWN_VENUES).toContain(AAVE);
  });
});

describe("a market is asked only about what it lists", () => {
  test("a revert for the wrong asset drops that pair and nothing else", async () => {
    // The failure that stopped the enclave the same day: one reverting call must not empty the
    // list. Compound-USDC reverts on WETH, and Aave's two must survive it.
    const { client } = chain({
      permitted: [
        { pool: AAVE, allowed: true },
        { pool: COMPOUND, allowed: true },
      ],
      lists,
      balances: { [AUSDC.toLowerCase()]: 1n },
    });
    const { positions } = await readVenues(client, ACCOUNT);
    expect(positions).toHaveLength(3);
    expect(
      positions.filter((p) => p.pool === COMPOUND).map((p) => p.asset),
    ).toEqual([USDC]);
  });
});

describe("a share count is not an amount of money", () => {
  test("a share-priced position is converted, a rebasing one is not", async () => {
    // #323, in the frontend. Our venues answer `getReserveAToken` with themselves; Aave answers
    // with a separate aToken, which is what tells the two apart without configuring anything.
    const { client } = chain({
      permitted: [
        { pool: AAVE, allowed: true },
        { pool: COMPOUND, allowed: true },
      ],
      lists,
      balances: { [AUSDC.toLowerCase()]: 100n, [COMPOUND.toLowerCase()]: 100n },
      sharePrice: 4n,
    });
    const { positions } = await readVenues(client, ACCOUNT);
    const aave = positions.find((p) => p.pool === AAVE && p.asset === USDC);
    const compound = positions.find((p) => p.pool === COMPOUND);

    expect(aave?.sharePriced).toBe(false);
    expect(aave?.supplied).toBe(100n);
    expect(compound?.sharePriced).toBe(true);
    expect(compound?.balance).toBe(100n);
    expect(compound?.supplied).toBe(400n);
  });

  test("a conversion that will not answer reports nothing, not the share count", async () => {
    // Reporting the shares would put a number in the wrong unit in front of an owner as money.
    const { client } = chain({
      permitted: [{ pool: COMPOUND, allowed: true }],
      lists,
      balances: { [COMPOUND.toLowerCase()]: 100n },
      previewThrows: true,
    });
    const { positions } = await readVenues(client, ACCOUNT);
    expect(positions[0]?.balance).toBe(100n);
    expect(positions[0]?.supplied).toBe(0n);
  });

  test("what is at work in one asset is the sum across its markets", async () => {
    const { client } = chain({
      permitted: [
        { pool: AAVE, allowed: true },
        { pool: COMPOUND, allowed: true },
        { pool: COMPOUND_WETH, allowed: true },
      ],
      lists,
      balances: {
        [AUSDC.toLowerCase()]: 100n,
        [COMPOUND.toLowerCase()]: 50n,
        [AWETH.toLowerCase()]: 9n,
        [COMPOUND_WETH.toLowerCase()]: 3n,
      },
      sharePrice: 2n,
    });
    const { positions } = await readVenues(client, ACCOUNT);
    // 100 rebasing + 50 shares at two apiece.
    expect(suppliedIn(positions, USDC)).toBe(200n);
    // 9 rebasing + 3 shares at two apiece. Assets do not mix.
    expect(suppliedIn(positions, WETH)).toBe(15n);
  });
});

describe("the list handed to escape", () => {
  test("names every asset and every receipt, once each", async () => {
    const { client } = chain({
      permitted: [
        { pool: AAVE, allowed: true },
        { pool: COMPOUND, allowed: true },
        { pool: COMPOUND_WETH, allowed: true },
      ],
      lists,
      balances: { [AUSDC.toLowerCase()]: 1n },
    });
    const { positions } = await readVenues(client, ACCOUNT);
    const list = sweepList(positions);

    expect(list).toContain(USDC);
    expect(list).toContain(WETH);
    expect(list).toContain(AUSDC);
    expect(list).toContain(AWETH);
    expect(list).toContain(COMPOUND);
    expect(list).toContain(COMPOUND_WETH);
    expect(new Set(list.map((t) => t.toLowerCase())).size).toBe(list.length);
    // Six, against the two the button used to send.
    expect(list).toHaveLength(6);
  });

  test("a receipt holding nothing is still named", async () => {
    // `escape` skips a zero balance without spending anything, and a transfer that lands between
    // building this list and sending it would otherwise be left behind.
    const { client } = chain({
      permitted: [{ pool: COMPOUND, allowed: true }],
      lists,
      balances: {},
    });
    const { positions } = await readVenues(client, ACCOUNT);
    expect(sweepList(positions)).toContain(COMPOUND);
  });

  test("and it never contains a duplicate when a receipt is also an asset", () => {
    expect(
      sweepList([
        {
          pool: AAVE,
          asset: USDC,
          receipt: USDC,
          sharePriced: false,
          balance: 0n,
          supplied: 0n,
        },
      ]),
    ).toEqual([...ACCOUNT_ASSETS]);
  });
});

describe("the markets an owner is offered", () => {
  const RAY = 10n ** 23n;
  const reserve = (rateBps: bigint) =>
    [
      0n,
      0n,
      rateBps * RAY,
      0n,
      0n,
      0n,
      0,
      0,
      ACCOUNT,
      ACCOUNT,
      ACCOUNT,
      ACCOUNT,
      0n,
      0n,
      0n,
    ] as const;

  const offering = (opts: {
    rates?: Record<string, bigint>;
    permits?: Record<string, boolean>;
    accountThrows?: boolean;
  }) =>
    ({
      readContract: async ({
        functionName,
        address,
        args,
      }: {
        functionName: string;
        address: Address;
        args?: readonly unknown[];
      }) => {
        if (functionName === "getReserveData") {
          const rate =
            opts.rates?.[
              `${address.toLowerCase()}:${String(args?.[0]).toLowerCase()}`
            ];
          // A venue reverts for an asset it does not list, exactly as the deployed ones do.
          if (rate === undefined) throw new Error("WrongAsset");
          return reserve(rate);
        }
        if (functionName === "permittedVenue") {
          if (opts.accountThrows) throw new Error("no code at this address");
          return opts.permits?.[String(args?.[0]).toLowerCase()] ?? false;
        }
        throw new Error(`unmodelled ${functionName}`);
      },
    }) as unknown as PublicClient;

  const rateFor = (m: Market) =>
    `${m.pool.toLowerCase()}:${m.asset.toLowerCase()}`;

  test("all four are offered, each with its own market's rate", async () => {
    // The defect this closes. Four markets are deployed and the product named one, so an owner
    // could not say yes to Morpho at 446 bps while holding USDC in Aave at 274.
    const rates = Object.fromEntries(
      MARKETS.map((m, i) => [
        rateFor(m),
        [274n, 287n, 446n, 125n][i] as bigint,
      ]),
    );
    const out = await readMarkets(offering({ rates }), ACCOUNT);
    expect(out).toHaveLength(4);
    expect(out.map((m) => m.bps)).toEqual([274, 287, 446, 125]);
    expect(bestBps(out)).toBe(446);
  });

  test("a market that will not answer reports nothing, not zero", async () => {
    // Zero is a rate. "Could not read it" is not, and only one of the two is a reason to leave a
    // market unpermitted — so they must not arrive as the same number.
    const first = MARKETS[0] as Market;
    const out = await readMarkets(
      offering({ rates: { [rateFor(first)]: 274n } }),
      ACCOUNT,
    );
    expect(out[0]?.bps).toBe(274);
    expect(out.slice(1).map((m) => m.bps)).toEqual([null, null, null]);
    expect(bestBps(out)).toBe(274);
  });

  test("and one that will not answer does not take the others down with it", async () => {
    const out = await readMarkets(offering({ rates: {} }), ACCOUNT);
    expect(out).toHaveLength(4);
    expect(bestBps(out)).toBeNull();
  });

  test("an account that does not exist yet permits nothing, which is not an error", async () => {
    const out = await readMarkets(offering({ accountThrows: true }), ACCOUNT);
    expect(out.every((m) => m.permitted === false)).toBe(true);
  });

  test("no account at all is read as permitting nothing, without asking", async () => {
    const out = await readMarkets(offering({}), null);
    expect(out.every((m) => m.permitted === false)).toBe(true);
  });

  test("what the account allows comes back per market, not as one flag", async () => {
    const [aave, , morpho] = MARKETS as unknown as [Market, Market, Market];
    const out = await readMarkets(
      offering({
        permits: {
          [aave.pool.toLowerCase()]: true,
          [morpho.pool.toLowerCase()]: true,
        },
      }),
      ACCOUNT,
    );
    expect(out.map((m) => m.permitted)).toEqual([true, false, true, false]);
  });

  test("the catalogue covers both assets", () => {
    // A list that is all USDC would leave the WETH venue unreachable, which is the shape of the
    // bug this replaces rather than a different one.
    const symbols = new Set(MARKETS.map((m) => m.assetSymbol));
    expect(symbols.has("USDC")).toBe(true);
    expect(symbols.has("ETH")).toBe(true);
  });

  test("and every address in it is distinct", () => {
    const pools = MARKETS.map((m) => m.pool.toLowerCase());
    expect(new Set(pools).size).toBe(pools.length);
  });
});
