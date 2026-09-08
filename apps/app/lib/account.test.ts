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
