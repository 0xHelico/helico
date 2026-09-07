import { describe, expect, test } from "bun:test";
import { addresses } from "@helico/plugin-uniswap";
import type { Address, PublicClient } from "viem";
import { checkVault, shortfall } from "./vault";

const ARBITRUM = 42161;
const real = addresses(ARBITRUM);
const VAULT: Address = "0x1111111111111111111111111111111111111111";

/**
 * A client that answers only what it is told to. Every branch of checkVault is reached by
 * changing what this returns, so the test exercises the real comparison rather than a mock of
 * the conclusion.
 */
function client({
  code = "0x60",
  answers,
}: {
  code?: string;
  answers?: Partial<Record<string, Address>> | "revert";
}) {
  return {
    getCode: async () => code as `0x${string}`,
    readContract: async ({ functionName }: { functionName: string }) => {
      if (answers === "revert" || !answers) {
        throw new Error("execution reverted");
      }
      const v = answers[functionName];
      if (!v) {
        throw new Error("execution reverted");
      }
      return v;
    },
  } as unknown as PublicClient;
}

const correct = {
  positionManager: real.positionManager,
  stateView: real.stateView,
  poolManager: real.poolManager,
};

describe("checkVault", () => {
  test("accepts a vault wired to this chain's own Uniswap deployment", async () => {
    const result = await checkVault(
      client({ answers: correct }),
      VAULT,
      ARBITRUM,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.positionManager).toBe(real.positionManager);
    }
  });

  test("refuses an address with no code", async () => {
    const result = await checkVault(
      client({ code: "0x", answers: correct }),
      VAULT,
      ARBITRUM,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/nothing is deployed/i);
    }
  });

  test("refuses a contract that does not answer like a vault", async () => {
    const result = await checkVault(
      client({ answers: "revert" }),
      VAULT,
      ARBITRUM,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/does not answer like a Helico vault/i);
    }
  });

  // The mistake this exists to catch: a vault that is real, but somebody else's deployment.
  test("refuses a vault built against a different periphery, and names which part", async () => {
    const other: Address = "0x2222222222222222222222222222222222222222";
    for (const [field, label] of [
      ["positionManager", "position manager"],
      ["stateView", "state view"],
      ["poolManager", "pool manager"],
    ] as const) {
      const result = await checkVault(
        client({ answers: { ...correct, [field]: other } }),
        VAULT,
        ARBITRUM,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain(label);
        expect(result.reason).toContain(other);
      }
    }
  });

  test("refuses a chain Uniswap v4 is not deployed on", async () => {
    const result = await checkVault(
      client({ answers: correct }),
      VAULT,
      999_999,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/not known on chain/i);
    }
  });
});

describe("shortfall", () => {
  test("is null while the balance is unknown, so nothing is refused on missing data", () => {
    expect(shortfall(undefined, 10n)).toBeNull();
  });

  test("is null when the balance covers it, exactly included", () => {
    expect(shortfall(10n, 10n)).toBeNull();
    expect(shortfall(11n, 10n)).toBeNull();
  });

  test("is the difference when it does not", () => {
    expect(shortfall(4n, 10n)).toBe(6n);
    expect(shortfall(0n, 10n)).toBe(10n);
  });
});
