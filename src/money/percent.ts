/**
 * Basis points as the percent a person reads: 1500 → '15', 1250 → '12.5', 1234 → '12.34'. Trailing zeros of the
 * fraction are dropped, never rounded: a basis point is the finest unit anything stores.
 */
export function formatBpsPercent(bps: number): string {
  if (!Number.isInteger(bps) || bps < 0) throw new Error(`formatBpsPercent: ${bps} is not a whole number of basis points`);
  const whole = Math.floor(bps / 100);
  const fraction = bps % 100;
  if (fraction === 0) return String(whole);
  return `${whole}.${String(fraction).padStart(2, '0').replace(/0$/, '')}`;
}
