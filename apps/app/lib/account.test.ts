import { describe, expect, test } from "bun:test";
import type { Address, PublicClient } from "viem";

import {
  type AccountState,
  hasAgent,
  readAccount,
  workingBps,
} from "./account";

const OWNER = "0x1111111111111111111111111111111111111111" as Address;
const FACTORY = "0x2222222222222222222222222222222222222222" as Address;
const ACCOUNT = "0x3333333333333333333333333333333333333333" as Address;
const AGENT = "0x4444444444444444444444444444444444444444" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const TOKENS = {
  idle: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as Address,
  working: "0x724dc807b04555b71ed48a6896b6F41593b8C637" as Address,
};

/** A client that answers what it is told to and throws for anything else. */
const client = (opts: {
  code?: string;
  balances?: Record<string, bigint>;
  agent?: Address | Error;
}) =>
  ({
    readContract: async ({
      functionName,
      address,
    }: {
      functionName: string;
      address: Address;
    }) => {
      if (functionName === "accountFor") return ACCOUNT;
      if (functionName === "balanceOf") {
        const v = opts.balances?.[address.toLowerCase()];
        if (v === undefined) throw new Error("no balance");
        return v;
      }
      if (functionName === "agent") {
        if (opts.agent instanceof Error) throw opts.agent;
        return opts.agent ?? ZERO;
      }
      throw new Error(`unexpected ${functionName}`);
    },
    getCode: async () => opts.code ?? "0x",
  }) as unknown as PublicClient;

describe("three states that look alike from outside", () => {
  // A missing environment variable and a user who has not started render the same "nothing to
  // show". Collapsing them is how a broken build reads as an empty account.
  test("no factory configured is its own answer, and asks the chain nothing", async () => {
    const never = {
      readContract: async () => {
        throw new Error("should not be called");
      },
    } as unknown as PublicClient;
    expect(await readAccount(never, null, OWNER, TOKENS)).toEqual({
      kind: "unconfigured",
    });
  });

  test("an unopened account still has an address and balances", async () => {
    const state = await readAccount(
      client({ balances: { [TOKENS.idle.toLowerCase()]: 1_000n } }),
      FACTORY,
      OWNER,
      TOKENS,
    );
    expect(state.kind).toBe("unopened");
    expect(state).toMatchObject({ address: ACCOUNT, idle: 1_000n });
  });

  // The point of a CREATE2 address: money can arrive before the contract does.
  test("and money sent before it exists is still read", async () => {
    const state = await readAccount(
      client({ balances: { [TOKENS.working.toLowerCase()]: 5n } }),
      FACTORY,
      OWNER,
      TOKENS,
    );
    expect(state).toMatchObject({ kind: "unopened", working: 5n });
  });

  test("code at the address is what makes it open", async () => {
    const state = await readAccount(
      client({ code: "0x60806040", agent: AGENT }),
      FACTORY,
      OWNER,
      TOKENS,
    );
    expect(state).toMatchObject({ kind: "open", agent: AGENT });
  });
});

describe("a partial answer beats one error for the whole panel", () => {
  test("a token that will not answer reads as zero, not as a failure", async () => {
    const state = await readAccount(
      client({ balances: { [TOKENS.idle.toLowerCase()]: 7n } }),
      FACTORY,
      OWNER,
      TOKENS,
    );
    expect(state).toMatchObject({ idle: 7n, working: 0n });
  });

  test("an account that cannot answer agent() still reports its balances", async () => {
    const state = await readAccount(
      client({
        code: "0x60806040",
        agent: new Error("no such function"),
        balances: { [TOKENS.idle.toLowerCase()]: 3n },
      }),
      FACTORY,
      OWNER,
      TOKENS,
    );
    expect(state).toMatchObject({ kind: "open", agent: null, idle: 3n });
  });
});

describe("what is at work, across every market", () => {
  const AUSDC = TOKENS.working;
  const COMPOUND = "0x1eC57cE1DdfdC7a4EbF4F54Aedee19ab73fcBB2E" as Address;

  /** A chain that answers the venue reads too, which the client above deliberately does not. */
  const withVenues = (balances: Record<string, bigint>, sharePrice = 1n) =>
    ({
      getCode: async () => "0xfe",
      getLogs: async () => [
        { args: { pool: COMPOUND, allowed: true } },
        { args: { pool: AUSDC, allowed: true } },
      ],
      readContract: async ({
        functionName,
        address,
        args,
      }: {
        functionName: string;
        address: Address;
        args?: readonly unknown[];
      }) => {
        if (functionName === "accountFor") return ACCOUNT;
        if (functionName === "agent") return AGENT;
        if (functionName === "balanceOf")
          return balances[address.toLowerCase()] ?? 0n;
        if (functionName === "getReserveAToken") {
          // Compound names itself; the Aave stand-in names a different receipt.
          if (address.toLowerCase() === COMPOUND.toLowerCase()) return COMPOUND;
          return AUSDC;
        }
        if (functionName === "previewRedeem")
          return BigInt(String(args?.[0])) * sharePrice;
        throw new Error(`unmodelled ${functionName}`);
      },
    }) as unknown as PublicClient;

  test("capital in a second market is counted, not reported as idle", async () => {
    // The defect this closes. `working` used to be one aToken balance, so an account whose
    // capital the enclave had moved to Compound read as 0% working — the agent doing its job
    // looking, on the owner's screen, like the money had gone.
    const state = await readAccount(
      withVenues(
        { [TOKENS.idle.toLowerCase()]: 0n, [COMPOUND.toLowerCase()]: 60n },
        2n,
      ),
      FACTORY,
      OWNER,
      TOKENS,
    );
    expect(state.kind).toBe("open");
    // 60 shares at two apiece, converted rather than counted.
    expect(state.kind === "open" && state.working).toBe(120n);
    expect(workingBps(state)).toBe(10_000);
  });

  test("and it never reads below the single market it replaced", async () => {
    // A venue that will not answer returns no position rather than throwing, so an empty sweep
    // and an account with nothing at work are indistinguishable here. The direct aToken reading
    // is a floor, and taking the larger is what keeps a failed read from reporting idle capital.
    const blind = {
      getCode: async () => "0xfe",
      getLogs: async () => {
        throw new Error("range too wide");
      },
      readContract: async ({
        functionName,
        address,
      }: {
        functionName: string;
        address: Address;
      }) => {
        if (functionName === "accountFor") return ACCOUNT;
        if (functionName === "agent") return AGENT;
        if (functionName === "balanceOf")
          return address.toLowerCase() === AUSDC.toLowerCase() ? 500n : 0n;
        throw new Error("this chain answers no venue read");
      },
    } as unknown as PublicClient;

    const state = await readAccount(blind, FACTORY, OWNER, TOKENS);
    expect(state.kind === "open" && state.working).toBe(500n);
  });
});

describe("who the agent is", () => {
  const open = (agent: Address | null): AccountState => ({
    kind: "open",
    address: ACCOUNT,
    idle: 0n,
    working: 0n,
    agent,
  });

  test("the zero address is nobody, not somebody called zero", () => {
    expect(hasAgent(open(ZERO))).toBe(false);
    expect(hasAgent(open(AGENT))).toBe(true);
  });

  test("an unopened account has no agent to have", () => {
    expect(
      hasAgent({ kind: "unopened", address: ACCOUNT, idle: 1n, working: 1n }),
    ).toBe(false);
  });
});

describe("the share that is working", () => {
  const at = (idle: bigint, working: bigint): AccountState => ({
    kind: "unopened",
    address: ACCOUNT,
    idle,
    working,
  });

  test("half and half is 5000 bps", () => {
    expect(workingBps(at(50n, 50n))).toBe(5000);
  });

  // Nothing at work out of nothing is not the same as nothing at work out of ten thousand, and
  // a bar reading 0% for both tells an owner their capital is idle when they have none.
  test("an empty account is null rather than zero", () => {
    expect(workingBps(at(0n, 0n))).toBeNull();
    expect(workingBps(at(1n, 0n))).toBe(0);
  });

  test("amounts beyond a double still divide", () => {
    expect(workingBps(at(10n ** 30n, 10n ** 30n))).toBe(5000);
  });
});
