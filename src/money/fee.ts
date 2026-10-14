/** Basis points out of 10 000. */
export const BPS_DENOMINATOR = 10_000n;

export interface FeeBreakdown {
  feeBps: number;
  feeAmount: bigint;
  totalAmount: bigint;
}

/**
 * The fee is paid on top of the price: the recipient receives `amount`, the fee recipient
 * `feeAmount`, and the payer signs for the sum. BigInt division truncates, which for
 * non-negative values is the floor — so a rounding difference is always in the payer's favour.
 */
export function computeFee(amount: bigint, feeBps: number): FeeBreakdown {
  const feeAmount = (amount * BigInt(feeBps)) / BPS_DENOMINATOR;
  return { feeBps, feeAmount, totalAmount: amount + feeAmount };
}
