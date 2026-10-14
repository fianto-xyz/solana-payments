// USDC has 6 decimals. Amounts travel as decimal strings and are handled as bigint base units.
export const USDC_DECIMALS = 6;
export const USDC_AMOUNT_PATTERN = /^\d{1,7}(\.\d{1,6})?$/;

const UNIT = 10n ** BigInt(USDC_DECIMALS);

/** Decimal string → USDC base units, by string arithmetic: a float never touches money. */
export function parseUsdcAmount(value: string): bigint | null {
  if (!USDC_AMOUNT_PATTERN.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * UNIT + BigInt(fraction.padEnd(USDC_DECIMALS, '0'));
}

/** Base units → shortest decimal string: 10_500_000n → "10.5". Never exponent notation. */
export function formatUsdcAmount(amount: bigint): string {
  const whole = amount / UNIT;
  const fraction = (amount % UNIT)
    .toString()
    .padStart(USDC_DECIMALS, '0')
    .replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** 2^64 − 1: the largest amount an SPL token transfer can carry. */
export const U64_MAX = 18_446_744_073_709_551_615n;

/** Whether `amount` lies in [min, max]; defaults to 1 base unit … u64 max. */
export function isAmountInRange(amount: bigint, bounds: { min?: bigint; max?: bigint } = {}): boolean {
  const { min = 1n, max = U64_MAX } = bounds;
  return amount >= min && amount <= max;
}
