"use client";

import { type Address, encodeFunctionData } from "viem";
import {
  useAccount,
  useCapabilities,
  useSendCalls,
  useWaitForCallsStatus,
} from "wagmi";

import {
  accountWriteAbi,
  configuredFactory,
  factoryAbi,
  HELICO_AGENT,
} from "@/lib/account";
import { MARKETS } from "@/lib/venues";
import { CHAIN_ID, useAccountState } from "@/hooks/use-account-state";

/**
 * Open the account, nominate the agent, and allow every market — in one confirmation.
 *
 * **One confirmation, never none, and the difference is not a detail.** `setAgent` and
 * `permitVenue` are `msg.sender != owner()` reverts, and `executeBatch` runs each call *as the
 * account*, so the account cannot administer itself. Measured on a fork rather than reasoned
 * about: `execute(self, setAgent(…))` from the owner reverts `CallFailed` naming the account's own
 * address, while the owner calling `setAgent` directly succeeds (#289).
 *
 * EIP-5792 batches at the **wallet** instead, so every call keeps the owner as `msg.sender` and
 * both setters pass. That is what collapses six prompts into one — and it is also why nothing in
 * this app may say "without signing". The owner's signature on these calls is the whole reason a
 * compromised agent is harmless.
 *
 * A wallet without EIP-5792 gets `canBatch: false`. It is not a failure and must not be treated as
 * one: the two controls on the limits page do the same job one transaction at a time.
 */
export function useUnlock() {
  const { address, isConnected } = useAccount();
  const { data } = useAccountState();
  const factory = configuredFactory();

  const capabilities = useCapabilities({ query: { enabled: isConnected } });
  const atomic = capabilities.data?.[CHAIN_ID]?.atomic?.status;
  const canBatch = atomic === "supported" || atomic === "ready";

  const send = useSendCalls();
  const batch = useWaitForCallsStatus({ id: send.data?.id });

  const account =
    data && data.kind !== "unconfigured" ? (data.address as Address) : undefined;
  const opened = data?.kind === "open";

  const unlock = () => {
    if (!(account && address)) return;
    send.sendCalls({
      calls: [
        // Only when it is needed. `open` has no access control and returns the existing address
        // rather than reverting, so including it twice would cost gas rather than correctness —
        // but a batch that is one call shorter is one call cheaper for everybody who has it.
        ...(opened || !factory
          ? []
          : [
              {
                to: factory,
                data: encodeFunctionData({
                  abi: factoryAbi,
                  functionName: "open",
                  args: [address as Address],
                }),
              },
            ]),
        {
          to: account,
          data: encodeFunctionData({
            abi: accountWriteAbi,
            functionName: "setAgent",
            args: [HELICO_AGENT as Address],
          }),
        },
        // Every market, not the one this used to name. "Unlock everything" that quietly permitted
        // Aave alone would leave the enclave choosing between one option and calling it the best.
        ...MARKETS.map((m) => ({
          to: account,
          data: encodeFunctionData({
            abi: accountWriteAbi,
            functionName: "permitVenue",
            args: [m.pool as Address, true],
          }),
        })),
      ],
    });
  };

  return {
    canBatch,
    unlock,
    /** How many on-chain calls it will make, which is what the copy beside the button promises. */
    steps: (opened ? 0 : 1) + 1 + MARKETS.length,
    pending: send.isPending || batch.isLoading,
    done: batch.data?.status === "success",
    error: send.error,
    ready: Boolean(account && address),
  };
}
