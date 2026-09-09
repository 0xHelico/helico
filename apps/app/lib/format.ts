import { formatUnits } from "viem";

/**
 * A balance, and never "0" when there is some.
 *
 * Two decimals is right in a mandates table and wrong everywhere a person reads their own money:
 * 0.005 ETH and 0.004 USDC both come back as "0", and somebody is told they hold nothing while
 * holding the thing they asked about. Four decimals, with a floor marker below that.
 */
export function amountShort(value: bigint, decimals: number): string {
  const n = Number(formatUnits(value, decimals));
  const shown = n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return shown === "0" ? "<0.0001" : shown;
}

/**
 * The same, rounded **down**, for a number that is a promise rather than a description.
 *
 * `amountShort` rounds, which turns a guaranteed minimum of 245.470356 into "245.4704" — four ten
 * thousandths more than the swap will actually guarantee. Nobody is harmed by that size of error
 * and it is still the wrong direction on a screen somebody signs, so a floor costs one function.
 */
export function amountFloor(value: bigint, decimals: number): string {
  if (decimals <= 4) {
    return formatUnits(value, decimals);
  }
  const scale = 10n ** BigInt(decimals - 4);
  const n = Number(formatUnits((value / scale) * scale, decimals));
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}
