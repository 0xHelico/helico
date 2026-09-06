import { vaultAbi } from "@helico/plugin-cre/abi";
import type { Address } from "viem";

export { vaultAbi };

/**
 * Helico's vault on Arbitrum One. Unset until it is deployed, and the app says so rather than
 * offering buttons that cannot work. `#85` is the deployment.
 */
export const vaultAddress = (process.env.NEXT_PUBLIC_VAULT_ADDRESS ?? "") as
  | Address
  | "";

/** Sensible starting terms. Every one of them is the user's to change before signing. */
export const MANDATE_DEFAULTS = {
  rangeWidthTicks: 1000,
  minImprovementBps: 50,
  cooldownSeconds: 3600,
  expiryDays: 30,
  minRetainedBps: 9000,
} as const;
